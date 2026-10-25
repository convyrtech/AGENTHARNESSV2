/**
 * «Править» in «Дизайн»: the places the owner marked on the built page (picks of the preview
 * inspector) with his words, and what main gets for them.
 */
import type { DesignEditPin, DesignTextEdit, PreviewPick } from "@zeno/contracts";

export type EditPin = { pick: PreviewPick; request: string };

export const MAX_EDIT_PINS = 10;

/** A new pick joins the list unless the same element is already marked. */
export function addPin(pins: readonly EditPin[], pick: PreviewPick): EditPin[] {
  const same = (p: EditPin) => p.pick.selector === pick.selector && p.pick.nth === pick.nth;
  if (pins.some(same) || pins.length >= MAX_EDIT_PINS) return [...pins];
  return [...pins, { pick, request: "" }];
}

/** What main gets: the place as the inspector saw it, the owner's words, the preview width. */
export function pinsToSend(pins: readonly EditPin[], width: number): DesignEditPin[] {
  return pins.map(({ pick, request }) => ({
    selector: pick.selector,
    nth: pick.nth,
    of: pick.of,
    tag: pick.tag,
    text: pick.text,
    outerHTMLShort: pick.outerHTMLShort,
    ...(pick.file ? { file: pick.file, ...(pick.line ? { line: pick.line } : {}) } : {}),
    request: request.trim(),
    width,
  }));
}

/** The «Править» page's own text script (`main/design/text-overlay.js`). */
export const TEXT_SOURCE = "prsloy-design-text";

export type TextRefusal = "nested" | "move" | "unmarked";
export type TextMessage =
  | ({ type: "text-edit" } & DesignTextEdit)
  | { type: "text-refused"; reason: TextRefusal };

const REFUSALS = new Set<TextRefusal>(["nested", "move", "unmarked"]);

/** A message of the text script, shape-checked and clamped (the page is untrusted); else undefined. */
export function parseTextMessage(data: unknown): TextMessage | undefined {
  if (!data || typeof data !== "object") return undefined;
  const raw = data as Record<string, unknown>;
  if (raw.source !== TEXT_SOURCE) return undefined;
  if (raw.type === "text-refused") {
    return REFUSALS.has(raw.reason as TextRefusal)
      ? { type: "text-refused", reason: raw.reason as TextRefusal }
      : undefined;
  }
  if (raw.type !== "text-edit") return undefined;
  const whole = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : 0);
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
  const edit = {
    type: "text-edit" as const,
    file: str(raw.file, 300),
    line: whole(raw.line),
    col: whole(raw.col),
    before: str(raw.before, 2000),
    after: str(raw.after, 2001),
  };
  return edit.file && edit.line && edit.col ? edit : undefined;
}
