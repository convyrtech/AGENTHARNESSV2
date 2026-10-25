/**
 * Final text / thinking of an assistant message, sent with `message.completed` so the
 * renderer can reconcile what it streamed (deltas) with what pi stored.
 */
export function assistantFinalContent(content: unknown): { text: string; thinking?: string } {
  let text = "";
  let thinking = "";
  if (Array.isArray(content)) {
    for (const block of content as { type?: unknown; text?: unknown; thinking?: unknown }[]) {
      if (block?.type === "text" && typeof block.text === "string") text += block.text;
      else if (block?.type === "thinking" && typeof block.thinking === "string") {
        thinking += block.thinking;
      }
    }
  } else if (typeof content === "string") {
    text = content;
  }
  return thinking ? { text, thinking } : { text };
}
