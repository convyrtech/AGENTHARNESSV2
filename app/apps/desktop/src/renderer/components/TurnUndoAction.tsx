/**
 * «Откатить» under a finished turn that changed files: confirm, restore the workspace to
 * the snapshot taken before that turn, then say how many files came back. «Вернуть как
 * было» re-applies the backup main took right before the undo.
 */
import { useEffect, useState } from "react";
import { RotateCcw, Undo2 } from "lucide-react";
import { t, type Locale } from "../lib/i18n.ts";
import { undoneFileCount, undoResultKey } from "../lib/turn-undo.ts";
import {
  loadUndoOutcome,
  saveUndoOutcome,
  UNDO_LOG_CHANGED_EVENT,
  type UndoOutcome,
} from "../lib/undo-log.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

type Outcome = UndoOutcome | { kind: "error"; message: string };

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
  // A past undo of this turn is shown again after a remount or restart.
  const [outcome, setOutcome] = useState<Outcome | undefined>(() =>
    loadUndoOutcome(props.snapshotId),
  );

  async function restore(snapshotId: string, kind: UndoOutcome["kind"]) {
    setBusy(true);
    try {
      const result = await window.zeno.prsloy.undoTurn(snapshotId);
      const count = undoneFileCount(result);
      const next: UndoOutcome =
        kind === "undone" ? { kind, count, backupId: result.backup?.id } : { kind, count };
      saveUndoOutcome(props.snapshotId, next);
      setOutcome(next);
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

  useEffect(() => {
    const sync = () => {
      const saved = loadUndoOutcome(props.snapshotId);
      if (saved) setOutcome(saved);
    };
    window.addEventListener(UNDO_LOG_CHANGED_EVENT, sync);
    return () => window.removeEventListener(UNDO_LOG_CHANGED_EVENT, sync);
  }, [props.snapshotId]);

  const locked = props.disabled || busy;
  return (
    <div className="turn-undo" data-testid="turn-undo">
      {outcome?.kind === "undone" ? (
        <>
          <span className="turn-undo-result" role="status" data-testid="turn-undo-result">
            {tr(undoResultKey(props.locale, outcome.count), { count: String(outcome.count) })}
          </span>
          {outcome.backupId ? (
            <button
              type="button"
              className="turn-undo-btn"
              data-testid="turn-undo-restore"
              disabled={locked}
              onClick={() => outcome.backupId && void restore(outcome.backupId, "restored")}
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
          void restore(props.snapshotId, "undone");
        }}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}
