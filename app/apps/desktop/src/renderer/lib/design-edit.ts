/**
 * «Править» in «Дизайн»: the places the owner marked on the built page (picks of the preview
 * inspector) with his words, and what main gets for them.
 */
import type { DesignEditPin, PreviewPick } from "@zeno/contracts";

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
