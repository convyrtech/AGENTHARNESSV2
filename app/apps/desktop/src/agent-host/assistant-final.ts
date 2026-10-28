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

/**
 * Stable identity of the assistant message behind a pi message_* event (its `responseId`
 * when the provider sent one, otherwise the request-start timestamp pi stamps on the
 * message object). The renderer uses it to keep two consecutive replies in two bubbles
 * instead of gluing them (#79). Undefined for non-assistant messages.
 */
export function assistantMessageId(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const row = message as { role?: unknown; responseId?: unknown; timestamp?: unknown };
  if (row.role !== "assistant") return undefined;
  if (typeof row.responseId === "string" && row.responseId.trim()) return `r:${row.responseId}`;
  if (typeof row.timestamp === "number" && Number.isFinite(row.timestamp)) {
    return `t:${row.timestamp}`;
  }
  return undefined;
}
