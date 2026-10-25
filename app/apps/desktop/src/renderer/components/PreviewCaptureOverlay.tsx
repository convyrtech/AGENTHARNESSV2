/**
 * The layer over the «Код» preview while the owner draws a frame for «Снять часть
 * страницы». Coordinates go out in window CSS pixels; Esc or a click without a drag cancels.
 */
import { useEffect, useRef, useState } from "react";
import { dragRect, isSelection, type Point, type Rect } from "../lib/preview-capture.ts";

export function PreviewCaptureOverlay(props: {
  hint: string;
  onPicked: (rect: Rect) => void;
  onCancel: () => void;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const [start, setStart] = useState<Point | undefined>();
  const [end, setEnd] = useState<Point | undefined>();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);

  const local = (event: { clientX: number; clientY: number }): Point => {
    const box = layer.current?.getBoundingClientRect();
    return { x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) };
  };
  const frame = start && end ? dragRect(start, end) : undefined;

  return (
    <div
      ref={layer}
      className="preview-capture-layer"
      data-testid="code-preview-capture-layer"
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture?.(event.pointerId);
        const p = local(event);
        setStart(p);
        setEnd(p);
      }}
      onPointerMove={(event) => start && setEnd(local(event))}
      onPointerUp={(event) => {
        if (!start) return;
        const rect = dragRect(start, local(event));
        setStart(undefined);
        setEnd(undefined);
        if (!isSelection(rect)) return;
        const box = layer.current?.getBoundingClientRect();
        props.onPicked({ ...rect, x: rect.x + (box?.left ?? 0), y: rect.y + (box?.top ?? 0) });
      }}
    >
      {frame ? (
        <div
          className="preview-capture-frame"
          style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height }}
        />
      ) : (
        <span className="preview-capture-hint">{props.hint}</span>
      )}
    </div>
  );
}
