import type { Content, Message } from "spectrum-ts";

/** Pulls plain text out of a message's content, unwrapping one level of `reply`. Returns "" for content with no text (attachments, control signals, etc). */
export function extractText(content: Content): string {
  switch (content.type) {
    case "text":
      return content.text;
    case "markdown":
      return content.markdown;
    case "reply":
      return extractText(content.content as Content);
    default:
      return "";
  }
}

/** When `message` was sent as an inline reply to another message, returns that target message. */
export function getReplyTarget(message: Message): Message | undefined {
  const content = message.content;
  return content.type === "reply" ? (content.target as Message) : undefined;
}

/** When `message` is an inbound tapback reaction, returns the emoji and the message it targets. */
export function getReaction(message: Message): { emoji: string; target: Message } | undefined {
  const content = message.content;
  if (content.type !== "reaction") return undefined;
  return { emoji: content.emoji, target: content.target as Message };
}
