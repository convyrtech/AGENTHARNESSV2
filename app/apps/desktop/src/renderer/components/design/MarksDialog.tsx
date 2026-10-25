/**
 * A card's picture, large, with a red brush on top (research/20 §10): the owner circles what to
 * change, «Приложить к ответу» sends the stroke layer to main, which lays it over the picture and
 * returns an attachment for the next answer. One colour, one width, «Очистить»; nothing else.
 */
import { Eraser, Loader2, Paperclip } from "lucide-react";
import { type PointerEvent, useRef, useState } from "react";
import { unwrapRemoteIpcError } from "../../../shared/ipc-error.ts";
import { t, type Locale, type MessageKey } from "../../lib/i18n.ts";
import { ContentPreviewDialog } from "../ContentPreviewDialog.tsx";
import { Button } from "../ui/button.tsx";

/** The one colour of the marks: a red no brand palette of ours is close to. */
export const MARK_RED = "#e5191c";

export function MarksDialog({
  open,
  onOpenChange,
  url,
  projectPath,
  locale,
  onAttached,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  url: string;
  projectPath: string | undefined;
  locale: Locale;
  onAttached: (file: { token: string; name: string }) => void;
}) {
  const tr = (key: MessageKey) => t(locale, key);
  const canvas = useRef<HTMLCanvasElement>(null);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [drawn, setDrawn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  // the canvas works in the picture's own pixels, whatever size it is shown at
  const fit = (img: HTMLImageElement) => {
    const c = canvas.current;
    if (!c) return;
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    setDrawn(false);
  };
  const point = (e: PointerEvent<HTMLCanvasElement>) => {
    const c = e.currentTarget;
    const box = c.getBoundingClientRect();
    return {
      x: ((e.clientX - box.left) * c.width) / box.width,
      y: ((e.clientY - box.top) * c.height) / box.height,
    };
  };
  const line = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx || !canvas.current) return;
    ctx.strokeStyle = MARK_RED;
    ctx.lineWidth = Math.max(4, canvas.current.width / 160);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  };
  const clear = () => {
    const c = canvas.current;
    c?.getContext("2d")?.clearRect(0, 0, c.width, c.height);
    setDrawn(false);
  };
  const attach = async () => {
    const c = canvas.current;
    if (!c) return;
    setBusy(true);
    setError(undefined);
    try {
      const blob = await new Promise<Blob | null>((resolve) => c.toBlob(resolve, "image/png"));
      if (!blob) throw new Error(tr("design.marks.failed"));
      const r = await window.zeno.design.attachMarks(
        projectPath,
        url,
        new Uint8Array(await blob.arrayBuffer()),
      );
      if (!r.ok) {
        setError(r.error);
        return;
      }
      onAttached({ token: r.token, name: r.name });
      clear();
      onOpenChange(false);
    } catch (e) {
      setError(unwrapRemoteIpcError(e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ContentPreviewDialog
      open={open}
      onOpenChange={onOpenChange}
      title={tr("design.marks.title")}
      closeLabel={t(locale, "timeline.imagePreviewClose")}
      className="content-image-preview-dialog"
      testId="design-marks"
    >
      <div className="flex h-full min-h-0 w-full flex-col items-center gap-3">
        <div className="relative min-h-0">
          <img
            src={url}
            alt=""
            className="content-image-preview-image max-h-[calc(100vh-180px)]"
            onLoad={(e) => fit(e.currentTarget)}
          />
          <canvas
            ref={canvas}
            className="absolute inset-0 size-full cursor-crosshair touch-none rounded-[12px]"
            aria-label={tr("design.marks.hint")}
            data-testid="design-marks-canvas"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              last.current = point(e);
              line(last.current, last.current);
              setDrawn(true);
            }}
            onPointerMove={(e) => {
              if (!last.current) return;
              const next = point(e);
              line(last.current, next);
              last.current = next;
            }}
            onPointerUp={() => {
              last.current = null;
            }}
          />
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2 rounded-lg bg-background px-3 py-2">
          <span className="text-sm text-muted-foreground">{tr("design.marks.hint")}</span>
          <Button
            variant="ghost"
            size="sm"
            disabled={!drawn || busy}
            data-testid="design-marks-clear"
            onClick={clear}
          >
            <Eraser />
            {tr("design.marks.clear")}
          </Button>
          <Button
            size="sm"
            disabled={!drawn || busy}
            data-testid="design-marks-attach"
            onClick={() => void attach()}
          >
            {busy ? <Loader2 className="animate-spin" /> : <Paperclip />}
            {tr("design.marks.attach")}
          </Button>
          {error ? (
            <span
              className="text-sm text-destructive"
              role="alert"
              data-testid="design-marks-error"
            >
              {error}
            </span>
          ) : null}
        </div>
      </div>
    </ContentPreviewDialog>
  );
}
