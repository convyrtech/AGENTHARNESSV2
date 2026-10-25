/**
 * «Снять часть страницы»: the rectangle the renderer asks main to capture, checked. It comes
 * in CSS pixels of the app window; `capturePage` wants device-independent pixels, so the
 * window's zoom (Settings → масштаб) is applied, and the result is held inside the window.
 */
export type CaptureRect = { x: number; y: number; width: number; height: number };

/** Smaller than this is a slip of the mouse, not a selection. */
export const MIN_CAPTURE_PX = 8;

export function captureRect(
  raw: unknown,
  zoom: number,
  view: { width: number; height: number },
): CaptureRect | undefined {
  const r = raw as Partial<Record<keyof CaptureRect, unknown>> | null;
  const nums = [r?.x, r?.y, r?.width, r?.height];
  if (!nums.every((n) => typeof n === "number" && Number.isFinite(n))) return undefined;
  const [x, y, width, height] = nums as number[];
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const left = Math.max(0, Math.floor(x! * scale));
  const top = Math.max(0, Math.floor(y! * scale));
  const right = Math.min(view.width, Math.ceil((x! + width!) * scale));
  const bottom = Math.min(view.height, Math.ceil((y! + height!) * scale));
  if (right - left < MIN_CAPTURE_PX || bottom - top < MIN_CAPTURE_PX) return undefined;
  return { x: left, y: top, width: right - left, height: bottom - top };
}
