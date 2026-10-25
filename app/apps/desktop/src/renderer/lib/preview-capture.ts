/**
 * «Снять часть страницы» (research 19 §1.9): the frame the owner draws over the preview,
 * and the capture itself. Main takes the picture of our own window (`capturePage`), so
 * there is no «поделиться экраном» prompt, unlike bolt.diy's getDisplayMedia.
 */
export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; width: number; height: number };

/** The rectangle between two drag points, whichever way the mouse went. */
export function dragRect(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

/** Big enough to be a selection, not a click. Main checks the same again. */
export function isSelection(rect: Rect): boolean {
  return rect.width >= 8 && rect.height >= 8;
}

/** Two frames: the selection frame must be gone from the screen before main takes the picture. */
export function afterPaint(): Promise<void> {
  return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
}
