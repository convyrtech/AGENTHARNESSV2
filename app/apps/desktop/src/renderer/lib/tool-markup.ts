/**
 * Tool-call markup leaked into an assistant answer (DeepSeek through a6: the call arrives as
 * text, the answer repeats the reasoning and ends with `</｜DSML｜ invoke>` tags). The harness
 * (`@prsloy/harness`, tool-leak.ts) sends the model back to make a real call; here we only keep
 * the leak off the screen:
 * - lines with tool markup are cut from assistant text;
 * - an assistant row that repeats the reasoning above it is hidden (the collapsed reasoning
 *   stays). While it streams, a prefix of the reasoning (≥ 200 chars) is hidden too.
 * Patterns mirror packages/prsloy-harness/src/tool-leak.ts.
 */
import type { TimelineItem } from "./timeline.ts";

const TOOL_MARKUP: readonly RegExp[] = [
  /｜\s*DSML\s*｜/,
  /<｜\s*tool▁(?:calls?▁begin|calls?▁end|call▁begin|call▁end|sep|outputs?▁begin)\s*｜>/,
  /<\/?tool_call>/,
  /<\|\s*tool_(?:calls_section_begin|calls_section_end|call_begin|call_end|call_argument_begin)\s*\|>/,
];

/** A streamed duplicate is hidden only once it is this long (short answers may echo a short thought). */
const DUPLICATE_PREFIX_MIN = 200;

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

export function stripToolMarkup(text: string): string {
  if (!TOOL_MARKUP.some((re) => re.test(text))) return text;
  return text
    .split("\n")
    .filter((line) => !TOOL_MARKUP.some((re) => re.test(line)))
    .join("\n")
    .trimEnd();
}

export function repeatsThinking(text: string, thinking: string): boolean {
  const answer = normalize(text);
  const thought = normalize(thinking);
  if (!answer || !thought) return false;
  if (answer === thought) return answer.length > DUPLICATE_PREFIX_MIN;
  return answer.length >= DUPLICATE_PREFIX_MIN && thought.startsWith(answer);
}

/** Returns the rows without leaked markup; rows are copied only when changed. */
export function hideToolLeaks(items: TimelineItem[]): TimelineItem[] {
  const out: TimelineItem[] = [];
  let thinking = "";
  for (const item of items) {
    if (item.kind === "thinking") {
      thinking = item.text;
      out.push(item);
      continue;
    }
    if (item.kind !== "assistant") {
      if (item.kind === "user") thinking = "";
      out.push(item);
      continue;
    }
    const text = stripToolMarkup(item.text);
    const previous = thinking;
    thinking = "";
    if (!text.trim() || repeatsThinking(text, previous)) continue;
    out.push(text === item.text ? item : { ...item, text });
  }
  return out;
}
