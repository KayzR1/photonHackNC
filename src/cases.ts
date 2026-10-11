import { randomUUID } from "node:crypto";
import type { Message, Space } from "spectrum-ts";
import { extractText, getReaction, getReplyTarget } from "./content-utils.js";
import { getRecentPrecedent, insertCase, recordVerdict, updateCaseMode, updateCaseStatus } from "./db.js";
import { envNumber } from "./env.js";
import {
  JOIN_EMOJI,
  NO_EMOJI,
  YES_EMOJI,
  postExhibit,
  sendCaseOpening,
  sendJoinPrompt,
  sendJuryVotePrompt,
  sendModeVotePrompt,
  sendStatusNotice,
  sendVerdict,
  warnContempt,
} from "./imessage-features.js";
import { checkRecusal, generateCrossExamination, generateVerdict } from "./judge.js";
import type { CaseStatus, CourtMode, PartyKey, VerdictResult } from "./types.js";

const NO_SHOW_TIMEOUT_MS = envNumber("HUNG_JURY_TIMEOUT_MS", 90_000);
const JURY_VOTE_WINDOW_MS = envNumber("HUNG_JURY_VOTE_WINDOW_MS", 90_000);
const MODE_VOTE_TIMEOUT_MS = 60_000;
const JOIN_WAIT_TIMEOUT_MS = 120_000;
const APPEAL_WINDOW_MS = 60_000;

const CONTEMPT_WINDOW_MS = 10_000;
const CONTEMPT_SPAM_THRESHOLD = 4;
const INSULT_KEYWORDS = [
  "idiot",
  "stupid",
  "shut up",
  "fuck you",
  "asshole",
  "bitch",
  "moron",
  "loser",
  "dumbass",
  "retard",
];

const TRIGGER_PHRASES = ["objection!", "court is in session", "@jury"];

function matchesTrigger(text: string): boolean {
  const lower = text.toLowerCase();
  return TRIGGER_PHRASES.some((phrase) => lower.includes(phrase));
}

function shortId(userId: string): string {
  const emailMatch = userId.match(/^([^@]+)@/);
  if (emailMatch) return emailMatch[1];
  const digits = userId.replace(/\D/g, "");
  if (digits.length >= 4) return digits.slice(-4);
  return userId;
}

function titleFor(partyAId: string, partyBId: string): string {
  return `${shortId(partyAId)} v. ${shortId(partyBId)}`;
}

interface PartyState {
  key: PartyKey;
  userId: string;
  dmSpace?: Space;
  testimony?: string;
  noShow?: boolean;
  crossExamQuestions?: string[];
  crossExamAnswer?: string;
  appealUsed: boolean;
  contemptStrikes: number;
  recentMsgTimestamps: number[];
  timer?: NodeJS.Timeout;
}

interface CaseRuntime {
  id: string;
  groupSpace: Space;
  platform: string;
  title: string;
  status: CaseStatus;
  mode?: CourtMode;
  openingMessage?: Message;
  joinMessage?: Message;
  modeVoteMessage?: Message;
  juryVoteMessage?: Message;
  modeVotes: Partial<Record<PartyKey, CourtMode>>;
  juryVotes: Map<string, PartyKey>;
  parties: { A: PartyState; B?: PartyState };
  lastVerdict?: VerdictResult;
  appealWindowTimer?: NodeJS.Timeout;
  joinWaitTimer?: NodeJS.Timeout;
  modeVoteTimer?: NodeJS.Timeout;
}

export type DmOpener = (platform: string, userId: string) => Promise<Space>;

export class CaseEngine {
  private readonly cases = new Map<string, CaseRuntime>();
  private readonly activeCaseByGroup = new Map<string, string>();
  private readonly dmRoutesBySpaceId = new Map<string, { caseId: string; partyKey: PartyKey }>();

  constructor(private readonly openDm: DmOpener) {}

  async handleMessage(space: Space, message: Message): Promise<void> {
    if (message.direction !== "inbound") return;
    const sender = message.sender;
    if (!sender || sender.kind === "agent") return;

    const reaction = getReaction(message);
    if (reaction) {
      await this.handleReaction(message, sender.id, reaction.emoji, reaction.target);
      return;
    }

    const text = extractText(message.content);
    if (!text) return;

    const dmRoute = this.dmRoutesBySpaceId.get(space.id);
    if (dmRoute) {
      const runtime = this.cases.get(dmRoute.caseId);
      if (runtime) await this.handleDmText(runtime, dmRoute.partyKey, message, text);
      return;
    }

    const activeCaseId = this.activeCaseByGroup.get(space.id);
    if (activeCaseId) {
      const runtime = this.cases.get(activeCaseId);
      if (runtime) await this.handleCaseGroupText(runtime, message, sender.id, text);
      return;
    }

    if (matchesTrigger(text)) {
      await this.openCase(space, message, sender.id, text);
    }
  }

  // ---------------------------------------------------------------------
  // Case opening
  // ---------------------------------------------------------------------

  private async openCase(groupSpace: Space, triggerMessage: Message, partyAId: string, triggerText: string): Promise<void> {
    if (this.activeCaseByGroup.has(groupSpace.id)) {
      // A case is already underway in this chat; ignore the second summons.
      return;
    }

    const disputeHint = stripTriggerPhrase(triggerText);
    const recusal = await checkRecusal(disputeHint || triggerText);
    if (recusal.shouldRecuse) {
      await sendStatusNotice(groupSpace, recusal.reason ?? "The court declines to hear this one.");
      return;
    }

    const caseId = randomUUID();
    const replyTarget = getReplyTarget(triggerMessage);
    const partyBId =
      replyTarget?.sender && replyTarget.sender.id !== partyAId ? replyTarget.sender.id : undefined;

    const partyA: PartyState = {
      key: "A",
      userId: partyAId,
      appealUsed: false,
      contemptStrikes: 0,
      recentMsgTimestamps: [],
    };

    const runtime: CaseRuntime = {
      id: caseId,
      groupSpace,
      platform: triggerMessage.platform,
      title: partyBId ? titleFor(partyAId, partyBId) : `${shortId(partyAId)}'s case`,
      status: "summoned",
      modeVotes: {},
      juryVotes: new Map(),
      parties: { A: partyA },
    };

    this.cases.set(caseId, runtime);
    this.activeCaseByGroup.set(groupSpace.id, caseId);

    const opening = await sendCaseOpening(
      groupSpace,
      partyBId
        ? `⚖️ **Case opened.** *${runtime.title}*`
        : `⚖️ **Case opened — summoning the second party.** *${runtime.title}*`,
    );
    runtime.openingMessage = opening;

    if (partyBId) {
      runtime.parties.B = {
        key: "B",
        userId: partyBId,
        appealUsed: false,
        contemptStrikes: 0,
        recentMsgTimestamps: [],
      };
      await this.startModeVote(runtime);
      return;
    }

    if (opening) {
      runtime.joinMessage = await sendJoinPrompt(opening);
    }
    runtime.joinWaitTimer = setTimeout(() => this.abandonCase(runtime, "Nobody stepped forward as the second party. Case dismissed."), JOIN_WAIT_TIMEOUT_MS);
  }

  private async resolvePartyB(runtime: CaseRuntime, userId: string): Promise<void> {
    if (runtime.parties.B) return;
    if (runtime.joinWaitTimer) clearTimeout(runtime.joinWaitTimer);

    runtime.parties.B = {
      key: "B",
      userId,
      appealUsed: false,
      contemptStrikes: 0,
      recentMsgTimestamps: [],
    };
    runtime.title = titleFor(runtime.parties.A.userId, userId);
    if (runtime.openingMessage) {
      await runtime.openingMessage.edit(`⚖️ **Case opened.** *${runtime.title}*`);
    }
    await this.startModeVote(runtime);
  }

  private abandonCase(runtime: CaseRuntime, reason: string): void {
    if (runtime.status !== "summoned" || runtime.parties.B) return;
    void sendStatusNotice(runtime.groupSpace, reason);
    this.closeCase(runtime);
  }

  // ---------------------------------------------------------------------
  // Mode vote
  // ---------------------------------------------------------------------

  private async startModeVote(runtime: CaseRuntime): Promise<void> {
    runtime.status = "mode_vote";
    insertCase({
      id: runtime.id,
      groupId: runtime.groupSpace.id,
      title: runtime.title,
      parties: [runtime.parties.A.userId, runtime.parties.B!.userId],
      status: "mode_vote",
    });

    runtime.modeVoteMessage = await sendModeVotePrompt(runtime.groupSpace);
    runtime.modeVoteTimer = setTimeout(() => this.resolveModeVote(runtime, true), MODE_VOTE_TIMEOUT_MS);
  }

  private async resolveModeVote(runtime: CaseRuntime, timedOut: boolean): Promise<void> {
    if (runtime.status !== "mode_vote") return;
    if (runtime.modeVoteTimer) clearTimeout(runtime.modeVoteTimer);
    runtime.modeVoteTimer = undefined;

    const bothOpen = !timedOut && runtime.modeVotes.A === "open" && runtime.modeVotes.B === "open";
    runtime.mode = bothOpen ? "open" : "closed";
    updateCaseMode(runtime.id, runtime.mode);

    await sendStatusNotice(
      runtime.groupSpace,
      runtime.mode === "open"
        ? "Court will hear this in the open — testimony will be posted here, and the jury may vote."
        : "Court will hear this in closed session — testimony stays private.",
    );

    await this.startTestimony(runtime);
  }

  // ---------------------------------------------------------------------
  // Testimony
  // ---------------------------------------------------------------------

  private async startTestimony(runtime: CaseRuntime): Promise<void> {
    runtime.status = "testimony";
    updateCaseStatus(runtime.id, "testimony");
    await sendStatusNotice(runtime.groupSpace, "Court is now hearing testimony. Check your DMs.");

    for (const party of this.parties(runtime)) {
      const dmSpace = await this.openDm(runtime.platform, party.userId);
      party.dmSpace = dmSpace;
      this.dmRoutesBySpaceId.set(dmSpace.id, { caseId: runtime.id, partyKey: party.key });
      await dmSpace.send(
        `⚖️ Case: ${runtime.title}. Please state your side of the dispute — I'm listening. You have about ${Math.round(NO_SHOW_TIMEOUT_MS / 1000)}s.`,
      );
      party.timer = setTimeout(() => this.handleNoShow(runtime, party.key), NO_SHOW_TIMEOUT_MS);
    }
  }

  private handleNoShow(runtime: CaseRuntime, partyKey: PartyKey): void {
    const party = this.party(runtime, partyKey);
    if (!party) return;
    if (party.testimony !== undefined || party.noShow) return;
    party.noShow = true;
    party.testimony = "[No response — default judgment.]";

    if (runtime.status === "testimony") void this.maybeAdvanceFromTestimony(runtime);
    else if (runtime.status === "cross_examination") void this.maybeAdvanceFromCrossExam(runtime);
  }

  private async maybeAdvanceFromTestimony(runtime: CaseRuntime): Promise<void> {
    const a = runtime.parties.A;
    const b = runtime.parties.B!;
    if (a.testimony === undefined || b.testimony === undefined) return;

    if (runtime.mode === "open" && runtime.openingMessage) {
      await postExhibit(runtime.openingMessage, "A", a.testimony);
      await postExhibit(runtime.openingMessage, "B", b.testimony);
    } else {
      await sendStatusNotice(runtime.groupSpace, "Court has heard both sides.");
    }

    await this.startCrossExamination(runtime);
  }

  // ---------------------------------------------------------------------
  // Cross-examination
  // ---------------------------------------------------------------------

  private async startCrossExamination(runtime: CaseRuntime): Promise<void> {
    runtime.status = "cross_examination";
    updateCaseStatus(runtime.id, "cross_examination");

    const a = runtime.parties.A;
    const b = runtime.parties.B!;

    if (a.noShow && b.noShow) {
      await this.maybeAdvanceFromCrossExam(runtime);
      return;
    }

    const precedent = getRecentPrecedent(runtime.groupSpace.id);
    const result = await generateCrossExamination({
      title: runtime.title,
      testimonyA: a.testimony ?? "",
      testimonyB: b.testimony ?? "",
      precedent,
    });

    for (const [party, questions] of [
      [a, result.questionsForPartyA],
      [b, result.questionsForPartyB],
    ] as const) {
      if (party.noShow) continue;
      party.crossExamQuestions = questions;
      const dmSpace = party.dmSpace ?? (await this.openDm(runtime.platform, party.userId));
      await dmSpace.send(
        `A couple follow-up questions from the court:\n\n${questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}\n\nYou have about ${Math.round(NO_SHOW_TIMEOUT_MS / 1000)}s (one message covering both is fine).`,
      );
      party.timer = setTimeout(() => this.handleNoShow(runtime, party.key), NO_SHOW_TIMEOUT_MS);
    }

    await this.maybeAdvanceFromCrossExam(runtime);
  }

  private isDoneWithCrossExam(party: PartyState): boolean {
    return party.noShow === true || party.crossExamAnswer !== undefined || party.crossExamQuestions === undefined;
  }

  private async maybeAdvanceFromCrossExam(runtime: CaseRuntime): Promise<void> {
    const a = runtime.parties.A;
    const b = runtime.parties.B!;
    if (!this.isDoneWithCrossExam(a) || !this.isDoneWithCrossExam(b)) return;

    if (runtime.mode === "open") {
      await this.startJuryVote(runtime);
    } else {
      await this.renderVerdict(runtime);
    }
  }

  // ---------------------------------------------------------------------
  // Jury vote (open court only)
  // ---------------------------------------------------------------------

  private async startJuryVote(runtime: CaseRuntime): Promise<void> {
    runtime.status = "jury_vote";
    updateCaseStatus(runtime.id, "jury_vote");

    const windowSeconds = Math.round(JURY_VOTE_WINDOW_MS / 1000);
    runtime.juryVoteMessage = await sendJuryVotePrompt(runtime.groupSpace, windowSeconds);
    setTimeout(() => this.finishJuryVote(runtime), JURY_VOTE_WINDOW_MS);
  }

  private async finishJuryVote(runtime: CaseRuntime): Promise<void> {
    if (runtime.status !== "jury_vote") return;
    await this.renderVerdict(runtime);
  }

  // ---------------------------------------------------------------------
  // Verdict + appeals
  // ---------------------------------------------------------------------

  private async renderVerdict(runtime: CaseRuntime, opts?: { isAppeal: boolean }): Promise<void> {
    const a = runtime.parties.A;
    const b = runtime.parties.B!;

    const recusal = await checkRecusal(`${a.testimony ?? ""}\n\n${b.testimony ?? ""}`);
    if (recusal.shouldRecuse) {
      await sendStatusNotice(runtime.groupSpace, recusal.reason ?? "The court declines to rule on this one.");
      this.closeCase(runtime);
      return;
    }

    const precedent = getRecentPrecedent(runtime.groupSpace.id);
    const crossExamQA = [a, b]
      .filter((p) => p.crossExamQuestions)
      .map((p) => ({ party: p.key, questions: p.crossExamQuestions!, answer: p.crossExamAnswer }));

    let forA = 0;
    let forB = 0;
    for (const vote of runtime.juryVotes.values()) {
      if (vote === "A") forA += 1;
      else forB += 1;
    }

    const verdict = await generateVerdict({
      title: runtime.title,
      testimonyA: a.testimony ?? "",
      testimonyB: b.testimony ?? "",
      crossExamQA,
      juryTally: runtime.mode === "open" ? { forA, forB } : undefined,
      noShow: { partyA: !!a.noShow, partyB: !!b.noShow },
      contempt: { partyA: a.contemptStrikes >= 2, partyB: b.contemptStrikes >= 2 },
      precedent,
      isAppeal: opts?.isAppeal,
      originalVerdict: opts?.isAppeal ? runtime.lastVerdict : undefined,
    });

    recordVerdict(runtime.id, verdict);
    runtime.lastVerdict = verdict;
    runtime.status = "verdict";
    updateCaseStatus(runtime.id, "verdict");

    const header = opts?.isAppeal ? `🔨 APPEAL VERDICT — ${runtime.title}` : `⚖️ VERDICT — ${runtime.title}`;
    const text = `${header}\nHolding: ${verdict.ruling}\nReasoning: ${verdict.reasoning}\nOrder: ${verdict.sentence}`;
    await sendVerdict(runtime.groupSpace, text);

    const bothAppealsUsed = a.appealUsed && b.appealUsed;
    if (bothAppealsUsed) {
      this.closeCase(runtime);
    } else {
      await this.startAppealWindow(runtime);
    }
  }

  private async startAppealWindow(runtime: CaseRuntime): Promise<void> {
    const windowSeconds = Math.round(APPEAL_WINDOW_MS / 1000);
    await sendStatusNotice(
      runtime.groupSpace,
      `Either party may DM me "appeal" within ${windowSeconds}s for one appeal to a stricter court.`,
    );
    runtime.appealWindowTimer = setTimeout(() => this.closeCase(runtime), APPEAL_WINDOW_MS);
  }

  private async requestAppeal(runtime: CaseRuntime, partyKey: PartyKey): Promise<void> {
    const party = this.party(runtime, partyKey);
    if (!party || party.appealUsed || !runtime.appealWindowTimer) return;

    party.appealUsed = true;
    clearTimeout(runtime.appealWindowTimer);
    runtime.appealWindowTimer = undefined;

    await sendStatusNotice(runtime.groupSpace, `Party ${partyKey} appeals. Taking this to a stricter court...`);
    await this.renderVerdict(runtime, { isAppeal: true });
  }

  // ---------------------------------------------------------------------
  // Reactions (join / mode vote / jury vote)
  // ---------------------------------------------------------------------

  private async handleReaction(message: Message, senderId: string, emoji: string, target: Message): Promise<void> {
    const activeCaseId = this.activeCaseByGroup.get(message.space.id);
    if (!activeCaseId) return;
    const runtime = this.cases.get(activeCaseId);
    if (!runtime) return;

    if (runtime.status === "summoned" && runtime.joinMessage && target.id === runtime.joinMessage.id) {
      if (emoji !== JOIN_EMOJI) return;
      if (senderId === runtime.parties.A.userId || runtime.parties.B) return;
      await this.resolvePartyB(runtime, senderId);
      return;
    }

    if (runtime.status === "mode_vote" && runtime.modeVoteMessage && target.id === runtime.modeVoteMessage.id) {
      const partyKey = this.partyKeyForUser(runtime, senderId);
      if (!partyKey) return;
      if (emoji === YES_EMOJI) runtime.modeVotes[partyKey] = "open";
      else if (emoji === NO_EMOJI) runtime.modeVotes[partyKey] = "closed";
      else return;

      if (runtime.modeVotes.A && runtime.modeVotes.B) {
        await this.resolveModeVote(runtime, false);
      }
      return;
    }

    if (runtime.status === "jury_vote" && runtime.juryVoteMessage && target.id === runtime.juryVoteMessage.id) {
      if (senderId === runtime.parties.A.userId || senderId === runtime.parties.B?.userId) return;
      if (emoji === YES_EMOJI) runtime.juryVotes.set(senderId, "A");
      else if (emoji === NO_EMOJI) runtime.juryVotes.set(senderId, "B");
      return;
    }
  }

  // ---------------------------------------------------------------------
  // Group chatter + DM text during an active case
  // ---------------------------------------------------------------------

  private async handleCaseGroupText(runtime: CaseRuntime, message: Message, senderId: string, text: string): Promise<void> {
    const partyKey = this.partyKeyForUser(runtime, senderId);
    if (!partyKey) return;
    await this.checkContempt(runtime, partyKey, message, text);
  }

  private async handleDmText(runtime: CaseRuntime, partyKey: PartyKey, message: Message, text: string): Promise<void> {
    const ended = await this.checkContempt(runtime, partyKey, message, text);
    if (ended) return;

    const party = this.party(runtime, partyKey);
    if (!party) return;

    if (runtime.status === "testimony" && party.testimony === undefined) {
      if (party.timer) clearTimeout(party.timer);
      party.testimony = text;
      await message.space.send("Testimony received. Thank you.");
      await this.maybeAdvanceFromTestimony(runtime);
      return;
    }

    if (runtime.status === "cross_examination" && party.crossExamQuestions && party.crossExamAnswer === undefined) {
      if (party.timer) clearTimeout(party.timer);
      party.crossExamAnswer = text;
      await message.space.send("Answer received. Thank you.");
      await this.maybeAdvanceFromCrossExam(runtime);
      return;
    }

    if (runtime.status === "verdict" && runtime.appealWindowTimer && !party.appealUsed && /appeal/i.test(text)) {
      await this.requestAppeal(runtime, partyKey);
      return;
    }
  }

  // ---------------------------------------------------------------------
  // Contempt
  // ---------------------------------------------------------------------

  private async checkContempt(runtime: CaseRuntime, partyKey: PartyKey, message: Message, text: string): Promise<boolean> {
    const party = this.party(runtime, partyKey);
    if (!party) return false;

    const now = Date.now();
    party.recentMsgTimestamps = party.recentMsgTimestamps.filter((t) => now - t < CONTEMPT_WINDOW_MS);
    party.recentMsgTimestamps.push(now);

    const isSpam = party.recentMsgTimestamps.length > CONTEMPT_SPAM_THRESHOLD;
    const lower = text.toLowerCase();
    const isInsult = INSULT_KEYWORDS.some((kw) => lower.includes(kw));
    if (!isSpam && !isInsult) return false;

    party.contemptStrikes += 1;
    if (party.contemptStrikes === 1) {
      await warnContempt(
        message,
        "⚠️ Order! That's a warning for contempt of court — keep it civil and don't flood the thread. One more and this case is decided against you by default.",
      );
      return false;
    }

    await warnContempt(message, "⚠️ That's contempt of court, strike two. This case is decided against you by default.");
    await this.forceContemptVerdict(runtime, partyKey);
    return true;
  }

  private async forceContemptVerdict(runtime: CaseRuntime, partyKey: PartyKey): Promise<void> {
    for (const party of this.parties(runtime)) {
      if (party.timer) clearTimeout(party.timer);
      if (party.testimony === undefined) {
        party.testimony = party.key === partyKey ? "[Held in contempt of court.]" : "[No testimony — case ended early by contempt ruling against the other party.]";
      }
    }
    await this.renderVerdict(runtime);
  }

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  private parties(runtime: CaseRuntime): PartyState[] {
    return runtime.parties.B ? [runtime.parties.A, runtime.parties.B] : [runtime.parties.A];
  }

  private party(runtime: CaseRuntime, key: PartyKey): PartyState | undefined {
    return key === "A" ? runtime.parties.A : runtime.parties.B;
  }

  private partyKeyForUser(runtime: CaseRuntime, userId: string | undefined): PartyKey | undefined {
    if (!userId) return undefined;
    if (runtime.parties.A.userId === userId) return "A";
    if (runtime.parties.B?.userId === userId) return "B";
    return undefined;
  }

  private closeCase(runtime: CaseRuntime): void {
    runtime.status = "closed";
    updateCaseStatus(runtime.id, "closed");
    if (runtime.appealWindowTimer) clearTimeout(runtime.appealWindowTimer);
    if (runtime.joinWaitTimer) clearTimeout(runtime.joinWaitTimer);
    if (runtime.modeVoteTimer) clearTimeout(runtime.modeVoteTimer);
    for (const party of this.parties(runtime)) {
      if (party.timer) clearTimeout(party.timer);
      if (party.dmSpace) this.dmRoutesBySpaceId.delete(party.dmSpace.id);
    }
    this.activeCaseByGroup.delete(runtime.groupSpace.id);
    this.cases.delete(runtime.id);
  }
}

function stripTriggerPhrase(text: string): string {
  let result = text;
  for (const phrase of TRIGGER_PHRASES) {
    result = result.replace(new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), "");
  }
  return result.trim();
}
