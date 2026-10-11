import type { Message, Space } from "spectrum-ts";
import { markdown } from "spectrum-ts";
import { effect, imessage } from "spectrum-ts/providers/imessage";

export const JOIN_EMOJI = "🙋";
export const YES_EMOJI = "👍";
export const NO_EMOJI = "👎";
export const WARNING_EMOJI = "⚠️";

export async function sendCaseOpening(space: Space, text: string): Promise<Message | undefined> {
  return space.send(markdown(text));
}

export async function sendJoinPrompt(openingMessage: Message): Promise<Message | undefined> {
  return openingMessage.reply(
    markdown(`React ${JOIN_EMOJI} to this message to join as the other party in this dispute.`),
  );
}

export async function sendModeVotePrompt(space: Space): Promise<Message | undefined> {
  return space.send(
    markdown(
      `Both parties: how do you want this heard?\n\n${YES_EMOJI} = **open court** (testimony posted here, spectators can jury-vote)\n${NO_EMOJI} = **closed court** (testimony stays private in DMs)\n\nBoth of you react the same way, or it defaults to closed court.`,
    ),
  );
}

export async function sendJuryVotePrompt(space: Space, windowSeconds: number): Promise<Message | undefined> {
  return space.send(
    markdown(
      `🧑‍⚖️ **The jury may now vote.** ${YES_EMOJI} if you side with Exhibit A, ${NO_EMOJI} if you side with Exhibit B. You have about ${windowSeconds} seconds.`,
    ),
  );
}

export async function sendStatusNotice(space: Space, text: string): Promise<Message | undefined> {
  return space.send(text);
}

export async function postExhibit(
  openingMessage: Message,
  label: "A" | "B",
  text: string,
): Promise<Message | undefined> {
  return openingMessage.reply(markdown(`**Exhibit ${label}**\n\n${text}`));
}

/**
 * Posts the final verdict. Uses iMessage's "slam" message effect (the gavel
 * moment) when the space is a real iMessage chat; other providers (e.g. the
 * terminal provider used for dev) don't support effects, so we fall back to
 * a plain send.
 */
export async function sendVerdict(space: Space, text: string): Promise<Message | undefined> {
  if (imessage.is(space)) {
    return space.send(effect(markdown(text), imessage.effect.message.slam));
  }
  return space.send(markdown(text));
}

export async function warnContempt(message: Message, warningText: string): Promise<void> {
  await message.react(WARNING_EMOJI);
  await message.reply(warningText);
}
