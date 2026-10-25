/**
 * «Откатить» under a finished turn that changed files: confirm, restore the workspace to
 * the snapshot taken before that turn, then say how many files came back. «Вернуть как
 * было» re-applies the backup main took right before the undo.
 */
import { useState } from "react";
import { RotateCcw, Undo2 } from "lucide-react";
import type { PrsloyTurnSnapshot } from "@zeno/contracts";
import { t, type Locale } from "../lib/i18n.ts";
import { undoneFileCount, undoResultKey } from "../lib/turn-undo.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

type Outcome =
  | { kind: "done"; count: number; backup?: PrsloyTurnSnapshot | undefined }
  | { kind: "restored"; count: number }
  | { kind: "error"; message: string };

export function TurnUndoAction(props: {
  locale: Locale;
  snapshotId: string;
  /** A turn is running: undo is refused by main, so the action is disabled here. */
  disabled: boolean;
  onUndone?: () => void;
}) {
  const tr = (key: Parameters<typeof t>[1], vars?: Record<string, string>) =>
    t(props.locale, key, vars);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>();

  async function restore(snapshotId: string, kind: "done" | "restored") {
    setBusy(true);
    try {
      const result = await window.zeno.prsloy.undoTurn(snapshotId);
      const count = undoneFileCount(result);
      setOutcome(kind === "done" ? { kind, count, backup: result.backup } : { kind, count });
      props.onUndone?.();
    } catch (error) {
      setOutcome({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }

  const locked = props.disabled || busy;
  return (
    <div className="turn-undo" data-testid="turn-undo">
      {outcome?.kind === "done" ? (
        <>
          <span className="turn-undo-result" role="status" data-testid="turn-undo-result">
            {tr(undoResultKey(props.locale, outcome.count), { count: String(outcome.count) })}
          </span>
          {outcome.backup ? (
            <button
              type="button"
              className="turn-undo-btn"
              data-testid="turn-undo-restore"
              disabled={locked}
              onClick={() => outcome.backup && void restore(outcome.backup.id, "restored")}
            >
              <RotateCcw className="size-3.5" strokeWidth={1.75} />
              {tr("prsloy.undo.restoreBack")}
            </button>
          ) : null}
        </>
      ) : outcome?.kind === "restored" ? (
        <span className="turn-undo-result" role="status" data-testid="turn-undo-result">
          {tr("prsloy.undo.restored")}
        </span>
      ) : (
        <button
          type="button"
          className="turn-undo-btn"
          data-testid="turn-undo-btn"
          disabled={locked}
          title={props.disabled ? tr("prsloy.undo.busy") : undefined}
          onClick={() => setConfirming(true)}
        >
          <Undo2 className="size-3.5" strokeWidth={1.75} />
          {tr("prsloy.undo.short")}
        </button>
      )}
      {outcome?.kind === "error" ? (
        <span className="turn-undo-error" role="alert">
          {tr("prsloy.undo.failed", { error: outcome.message })}
        </span>
      ) : null}
      <ConfirmDialog
        open={confirming}
        title={tr("prsloy.undo.confirmTitle")}
        message={tr("prsloy.undo.confirmMessage")}
        confirmLabel={tr("prsloy.undo.short")}
        cancelLabel={tr("common.cancel")}
        testId="turn-undo-confirm"
        onConfirm={() => {
          setConfirming(false);
          void restore(props.snapshotId, "done");
        }}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}
