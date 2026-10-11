import { GoogleGenAI, Type, type Schema } from "@google/genai";
import type {
  CrossExamResult,
  JuryTally,
  PartyKey,
  PrecedentForJudge,
  RecusalResult,
  VerdictResult,
} from "./types.js";

const gemini = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = process.env.GEMINI_MODEL ?? "gemini-3.8-flash";

const JUDGE_PERSONA = `You are the Hung Jury, an AI judge presiding over disputes dropped into an iMessage group chat. Your persona: dry wit, a little theatrical (you enjoy a good gavel moment), scrupulously fair, and never cruel or mean to either party — the jokes land on the situation, not on the people. You take real disputes seriously even while having fun with the format.`;

/**
 * Fast-path safety net: forces recusal without waiting on a model call when the
 * dispute text contains unambiguous signals of money owed, physical safety, or
 * a serious relationship/mental-health matter. Intentionally blunt — the real
 * judgment call is the LLM check in `checkRecusal`, this just catches the
 * worst cases even if that call is slow, fails, or is somehow bypassed.
 */
const RECUSAL_KEYWORD_BLOCKLIST = [
  "suicide",
  "kill myself",
  "kill him",
  "kill her",
  "want to die",
  "self harm",
  "self-harm",
  "abuse",
  "abusive",
  "hit me",
  "hit him",
  "hit her",
  "punched",
  "assault",
  "rape",
  "weapon",
  "gun",
  "knife",
  "threatened me",
  "threatening me",
  "domestic violence",
  "overdose",
  "eating disorder",
  "cutting myself",
];

function matchesRecusalKeyword(text: string): string | undefined {
  const lower = text.toLowerCase();
  return RECUSAL_KEYWORD_BLOCKLIST.find((kw) => lower.includes(kw));
}

const RECUSAL_DECLINE_MESSAGE =
  "The court declines to hear this one. This sounds like it involves something more serious than Hung Jury is built for — money owed, safety, or something emotionally heavy. Please talk to each other directly, or reach out to someone who can actually help. Case dismissed, with care.";

async function callStructured<T>(opts: {
  system: string;
  prompt: string;
  label: string;
  schema: Schema;
}): Promise<T> {
  const response = await gemini.models.generateContent({
    model: MODEL,
    contents: opts.prompt,
    config: {
      systemInstruction: opts.system,
      responseMimeType: "application/json",
      responseSchema: opts.schema,
    },
  });

  const text = response.text;
  if (!text) {
    throw new Error(`Judge model returned no ${opts.label} output`);
  }
  return JSON.parse(text) as T;
}

/**
 * Real LLM judgment call on whether this dispute is too serious for an AI
 * judge in a group chat — money owed, physical safety, or a serious
 * relationship/mental-health matter. Callers should run
 * `matchesRecusalKeyword` first as a fast, cheap net; this is the considered
 * check for everything that net doesn't catch.
 */
export async function checkRecusal(disputeDescription: string): Promise<RecusalResult> {
  const keywordHit = matchesRecusalKeyword(disputeDescription);
  if (keywordHit) {
    return { shouldRecuse: true, reason: RECUSAL_DECLINE_MESSAGE };
  }

  return callStructured<RecusalResult>({
    system: JUDGE_PERSONA,
    prompt: `A dispute has been brought before the court. Here is everything said about it so far:\n\n"""\n${disputeDescription}\n"""\n\nDecide whether this is appropriate for an AI judge in a group chat to rule on for fun, or whether it actually involves money owed between the parties, physical safety, or a serious relationship/mental-health matter — in which case you should decline (recuse) rather than rule. When recusing, write a kind, brief, in-character reason that tells the parties to talk directly or seek real support. Do not be a killjoy about ordinary petty disputes (who left dishes in the sink, whose turn it is to pick the restaurant, a bad joke, etc.) — those are exactly what you're for.`,
    label: "recusal_decision",
    schema: {
      type: Type.OBJECT,
      properties: {
        shouldRecuse: {
          type: Type.BOOLEAN,
          description: "True if the judge should decline to rule on this dispute.",
        },
        reason: {
          type: Type.STRING,
          description:
            "Required when shouldRecuse is true: a kind, in-character message explaining the recusal to the parties.",
        },
      },
      required: ["shouldRecuse"],
    },
  });
}

export async function generateCrossExamination(input: {
  title: string;
  testimonyA: string;
  testimonyB: string;
  precedent: PrecedentForJudge[];
}): Promise<CrossExamResult> {
  return callStructured<CrossExamResult>({
    system: JUDGE_PERSONA,
    prompt: buildCrossExamPrompt(input),
    label: "cross_examination_questions",
    schema: {
      type: Type.OBJECT,
      properties: {
        questionsForPartyA: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          minItems: "1",
          maxItems: "2",
          description: "1-2 sharp, fair follow-up questions for party A.",
        },
        questionsForPartyB: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          minItems: "1",
          maxItems: "2",
          description: "1-2 sharp, fair follow-up questions for party B.",
        },
      },
      required: ["questionsForPartyA", "questionsForPartyB"],
    },
  });
}

function buildCrossExamPrompt(input: {
  title: string;
  testimonyA: string;
  testimonyB: string;
  precedent: PrecedentForJudge[];
}): string {
  return `Case: ${input.title}

Party A's testimony:
"""
${input.testimonyA}
"""

Party B's testimony:
"""
${input.testimonyB}
"""

${formatPrecedent(input.precedent)}

Ask each party 1-2 short, pointed follow-up questions that would actually help you reach a fair verdict — target the contradictions or gaps between their two stories. Keep them concise enough to answer by text.`;
}

export async function generateVerdict(input: {
  title: string;
  testimonyA: string;
  testimonyB: string;
  crossExamQA: { party: PartyKey; questions: string[]; answer: string | undefined }[];
  juryTally?: JuryTally;
  noShow?: { partyA: boolean; partyB: boolean };
  contempt?: { partyA: boolean; partyB: boolean };
  precedent: PrecedentForJudge[];
  isAppeal?: boolean;
  originalVerdict?: VerdictResult;
}): Promise<VerdictResult> {
  const system = input.isAppeal
    ? `${JUDGE_PERSONA} You are now sitting as a stricter, higher appellate court reviewing a lower ruling. Apply tougher scrutiny than the original judge, re-examine the record with fresh eyes, and be willing to overturn or affirm as the record actually supports — do not rubber-stamp the original ruling.`
    : JUDGE_PERSONA;

  return callStructured<VerdictResult>({
    system,
    prompt: buildVerdictPrompt(input),
    label: "render_verdict",
    schema: {
      type: Type.OBJECT,
      properties: {
        ruling: {
          type: Type.STRING,
          description: "A short holding — who, if anyone, is in the right. One or two sentences.",
        },
        reasoning: {
          type: Type.STRING,
          description: "The court's reasoning for the ruling, in the judge's dry, theatrical voice.",
        },
        sentence: {
          type: Type.STRING,
          description: "The concrete order: what the losing (or both) party must now do.",
        },
        citesPrecedent: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: "Titles of any earlier cases from the precedent list this ruling cites, if any.",
        },
      },
      required: ["ruling", "reasoning", "sentence"],
    },
  });
}

function buildVerdictPrompt(input: {
  title: string;
  testimonyA: string;
  testimonyB: string;
  crossExamQA: { party: PartyKey; questions: string[]; answer: string | undefined }[];
  juryTally?: JuryTally;
  noShow?: { partyA: boolean; partyB: boolean };
  contempt?: { partyA: boolean; partyB: boolean };
  precedent: PrecedentForJudge[];
  isAppeal?: boolean;
  originalVerdict?: VerdictResult;
}): string {
  const sections: string[] = [`Case: ${input.title}`];

  if (input.contempt?.partyA) {
    sections.push(
      `Party A was held in contempt of court (repeated spam/insults during proceedings) and the case ends with a default ruling against them.`,
    );
  }
  if (input.contempt?.partyB) {
    sections.push(
      `Party B was held in contempt of court (repeated spam/insults during proceedings) and the case ends with a default ruling against them.`,
    );
  }

  sections.push(
    `Party A's testimony:\n"""\n${input.noShow?.partyA ? "[Party A did not respond in time — no-show.]" : input.testimonyA}\n"""`,
  );
  sections.push(
    `Party B's testimony:\n"""\n${input.noShow?.partyB ? "[Party B did not respond in time — no-show.]" : input.testimonyB}\n"""`,
  );

  if (input.crossExamQA.length > 0) {
    const qaText = input.crossExamQA
      .map(
        (qa) =>
          `Party ${qa.party} was asked: ${qa.questions.join(" / ")}\nParty ${qa.party} answered: ${qa.answer ?? "[no answer given]"}`,
      )
      .join("\n\n");
    sections.push(`Cross-examination:\n${qaText}`);
  }

  if (input.juryTally) {
    sections.push(
      `The spectating jury tapback-voted: ${input.juryTally.forA} 👍 for Party A vs ${input.juryTally.forB} 👎 for Party B. Weigh this as public sentiment, not binding fact.`,
    );
  }

  sections.push(formatPrecedent(input.precedent));

  if (input.isAppeal && input.originalVerdict) {
    sections.push(
      `This is an appeal. The original ruling was:\nHolding: ${input.originalVerdict.ruling}\nReasoning: ${input.originalVerdict.reasoning}\nOrder: ${input.originalVerdict.sentence}\n\nReview the full record above with stricter scrutiny and decide whether the original ruling holds up.`,
    );
  }

  sections.push(
    `Render your verdict: a short holding, your reasoning, and a concrete order (the sentence). If either party no-showed or was held in contempt, the default ruling goes against them, but still explain why in your own voice. Cite any precedent case titles above that genuinely bear on this one.`,
  );

  return sections.join("\n\n");
}

function formatPrecedent(precedent: PrecedentForJudge[]): string {
  if (precedent.length === 0) {
    return "There is no prior precedent in this group chat.";
  }
  const lines = precedent
    .map((p) => `- ${p.title} — Holding: ${p.ruling} Order: ${p.sentence}`)
    .join("\n");
  return `Precedent from this group chat's prior cases (most recent first) — cite one by title if it genuinely bears on this case, otherwise ignore it:\n${lines}`;
}
