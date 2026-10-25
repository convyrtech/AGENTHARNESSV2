/**
 * «Править» under the built page (research/20 §1): the owner marks places on the page with the
 * preview inspector and says in a few words what to change at each. «Применить» sends them all as
 * one edit; the harness answers with a before/after sheet and «Оставить» / «Вернуть как было».
 */
import { Crosshair, Loader2, X } from "lucide-react";
import { useState } from "react";
import { type EditPin, MAX_EDIT_PINS } from "../../lib/design-edit.ts";
import { pickedLabel } from "../../lib/preview-bridge.ts";
import type { MessageKey } from "../../lib/i18n.ts";
import { Button } from "../ui/button.tsx";
import { Textarea } from "../ui/textarea.tsx";

export function EditPanel({
  pins,
  picking,
  note,
  tr,
  onPick,
  onChange,
  onApply,
  onCancel,
}: {
  pins: EditPin[];
  picking: boolean;
  /** What became of the last text retyped on the page. */
  note?: { ok: boolean; text: string };
  tr: (key: MessageKey) => string;
  onPick: () => void;
  onChange: (pins: EditPin[]) => void;
  /** Resolves when main took the edit; a rejection is the one-line error shown here. */
  onApply: () => Promise<void>;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const ready = pins.length > 0 && pins.every((p) => p.request.trim());
  const apply = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await onApply();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3" data-testid="design-edit">
      {pins.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="design-edit-hint">
          {tr("design.edit.hint")}
        </p>
      ) : (
        <ol className="flex flex-col gap-2">
          {pins.map((p, i) => (
            <li key={`${p.pick.selector}#${p.pick.nth}`} className="flex items-start gap-2">
              <span className="mt-1.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-xs text-primary-foreground tabular-nums">
                {i + 1}
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="truncate text-sm" data-testid={`design-edit-place-${i + 1}`}>
                  {pickedLabel(p.pick)}
                </span>
                <Textarea
                  rows={1}
                  className="min-h-9 resize-none text-sm"
                  aria-label={tr("design.edit.request")}
                  placeholder={tr("design.edit.request")}
                  value={p.request}
                  data-testid={`design-edit-request-${i + 1}`}
                  onChange={(e) =>
                    onChange(pins.map((x, j) => (j === i ? { ...x, request: e.target.value } : x)))
                  }
                />
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label={tr("design.edit.remove")}
                data-testid={`design-edit-remove-${i + 1}`}
                onClick={() => onChange(pins.filter((_, j) => j !== i))}
              >
                <X />
              </Button>
            </li>
          ))}
        </ol>
      )}
      <p className="text-xs text-muted-foreground">{tr("design.edit.textHint")}</p>
      {note ? (
        <p
          className={note.ok ? "text-sm text-muted-foreground" : "text-sm text-destructive"}
          role={note.ok ? "status" : "alert"}
          data-testid="design-edit-note"
        >
          {note.text}
        </p>
      ) : null}
      {error ? (
        <p className="text-sm text-destructive" role="alert" data-testid="design-edit-error">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {!picking && pins.length < MAX_EDIT_PINS ? (
          <Button
            variant="outline"
            size="sm"
            className="mr-auto"
            data-testid="design-edit-pick"
            onClick={onPick}
          >
            <Crosshair />
            {tr("design.edit.pick")}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          data-testid="design-edit-cancel"
          onClick={onCancel}
        >
          {tr("design.edit.cancel")}
        </Button>
        <Button
          size="sm"
          disabled={!ready || busy}
          data-testid="design-edit-apply"
          onClick={() => void apply()}
        >
          {busy ? <Loader2 className="animate-spin" /> : null}
          {tr("design.edit.apply")}
        </Button>
      </div>
    </div>
  );
}
