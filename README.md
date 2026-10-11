# Hung Jury ⚖️

An AI judge that lives inside iMessage group chats. Summon it into a dispute, it hears
testimony from both sides by DM, optionally lets spectators vote via tapbacks, and hands
down a verdict with a gavel effect. It remembers past rulings per group chat as precedent.

Built on [`spectrum-ts`](https://photon.codes/docs/spectrum-ts/introduction) for the
Photon track at HackNC 2026. There is no frontend — the product is the iMessage
conversation itself.

## Setup

1. Install dependencies:
   ```
   npm install
   ```
2. Copy `.env.example` to `.env` and fill in:
   ```
   SPECTRUM_PROJECT_ID=...
   SPECTRUM_PROJECT_SECRET=...
   ANTHROPIC_API_KEY=...
   ```
   Get Spectrum credentials from https://app.photon.codes/dashboard — promo code
   `HACKWITHPHOTON` unlocks a free month of Pro. Confirm with the dashboard whether your
   project's iMessage line is a dedicated line — only dedicated lines get group
   membership/rename events. This app never tries to create or rename groups; it assumes
   it's only ever added to a group that already exists.
3. Run it:
   ```
   npm run dev
   ```

## How a case runs

1. **Summon.** Someone sends a trigger phrase in a group chat: `objection!`,
   `court is in session`, or `@jury` (case-insensitive substring match). If the summons
   is itself an iMessage reply to someone else's message, that person automatically
   becomes the other party. Otherwise, the bot posts a prompt and the first other person
   to react 🙋 joins as the second party.
2. **Mode vote.** Both parties tapback 👍 (open court) or 👎 (closed court) on the
   prompt. Both must pick open within the window, or it defaults to closed.
3. **Testimony.** Each party is DM'd and asked for their side. In open court, both
   testimonies get reposted into the group as threaded replies ("Exhibit A" / "Exhibit
   B") under the case-opening message. In closed court, the group only sees short status
   notices — testimony content never leaves the DM thread it was given in, including in
   later precedent lookups.
4. **Cross-examination.** The judge model asks each party 1-2 follow-up questions by DM.
5. **Jury vote** (open court only). Spectators tapback-vote 👍/👎 on a prompt for a
   configurable window.
6. **Verdict.** The judge renders a structured ruling, holding, and sentence, and posts it
   with the iMessage "slam" effect (the gavel moment).
7. **Appeal.** Either party may DM "appeal" within a short window after the verdict for
   one re-run of the verdict step under a stricter, higher-court system prompt. Each party
   gets exactly one appeal per case.

Along the way:

- **No-shows** get a default judgment against them after a timeout
  (`HUNG_JURY_TIMEOUT_MS`, default 90s for demo purposes).
- **Recusal**: before opening a case, and again before rendering a verdict, the judge
  model makes a real judgment call on whether the dispute actually involves money owed,
  physical safety, or a serious relationship/mental-health matter — and declines kindly
  if so. A fast keyword blocklist (`src/judge.ts`) acts as a safety net that forces
  recusal without waiting on the model call.
- **Contempt**: spamming the case thread or sending insults gets a ⚠️ reaction and one
  warning DM. A second violation ends the case immediately with a default ruling against
  that party.
- **Precedent**: the 3-5 most recent decided cases in a group chat (title, ruling,
  sentence only — never raw testimony) are passed to the judge as context for new cases,
  so it can cite prior rulings by name (e.g. "Priya v. Jake").

## Project layout

- `src/index.ts` — Spectrum bootstrap and the main message loop; routes inbound
  messages/reactions to the case engine.
- `src/cases.ts` — the case state machine (summon → mode vote → testimony →
  cross-examination → jury vote → verdict → closed) and its in-memory runtime state.
- `src/judge.ts` — the three structured Claude calls (recusal check, cross-examination
  questions, verdict), all forced to JSON via tool-use so the rest of the app never
  parses free text.
- `src/imessage-features.ts` — thin wrappers around tapback prompts, threaded exhibit
  replies, and the gavel ("slam") effect.
- `src/db.ts` — SQLite schema and queries for case + precedent storage.
- `src/content-utils.ts` — small helpers for pulling text/reactions/reply-targets out of
  Spectrum's `Content` union.

## Dev loop

Both `imessage.config()` and `terminal.config()` are registered as providers, so you can
drive the state machine from the terminal provider without a phone for quick checks —
though the group-chat flow (trigger phrases, tapback votes, threaded exhibits) is really
only exercisable in a real iMessage group chat.
