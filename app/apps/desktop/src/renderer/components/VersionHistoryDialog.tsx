/**
 * «История версий» (research 19 §1.8, by the example of Dyad's VersionPane): every snapshot
 * core took before a request in this project, newest first, with «Вернуть». Going back is
 * core's `undoTurn`: it saves the current state first, so the owner can always come back.
 */
import type { PrsloyTurnSnapshot } from "@zeno/contracts";
import { History, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { t, type Locale } from "../lib/i18n.ts";
import { undoneFileCount, undoResultKey } from "../lib/turn-undo.ts";
import { saveUndoOutcome } from "../lib/undo-log.ts";
import { historyEntries, historyTime, historyWhat } from "../lib/version-history.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import "./code-preview-features.css";

type Note = { kind: "ok" | "error"; text: string };

export function VersionHistoryDialog(props: {
  locale: Locale;
  open: boolean;
  /** A turn is running: core refuses to go back, so the buttons wait. */
  running: boolean;
  onClose: () => void;
}) {
  const tr = (key: Parameters<typeof t>[1], vars?: Record<string, string>) =>
    t(props.locale, key, vars);
  const [entries, setEntries] = useState<PrsloyTurnSnapshot[] | undefined>();
  const [asking, setAsking] = useState<PrsloyTurnSnapshot | undefined>();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | undefined>();
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    if (!props.open) return;
    let alive = true;
    window.zeno.prsloy
      .listTurns()
      .then((list) => alive && setEntries(historyEntries(list)))
      .catch(() => alive && setEntries([]));
    return () => {
      alive = false;
    };
  }, [props.open, reloads]);

  useEffect(() => {
    if (!props.open) {
      setEntries(undefined);
      setNote(undefined);
    }
  }, [props.open]);

  async function restore(snapshot: PrsloyTurnSnapshot) {
    setBusy(true);
    setNote(undefined);
    try {
      const result = await window.zeno.prsloy.undoTurn(snapshot.id);
      const count = undoneFileCount(result);
      // The turn's own «Откатить» under the message shows the same result.
      if (snapshot.kind === "turn") {
        saveUndoOutcome(snapshot.id, { kind: "undone", count, backupId: result.backup?.id });
      }
      setNote({
        kind: "ok",
        text: tr(undoResultKey(props.locale, count), { count: String(count) }),
      });
    } catch (error) {
      setNote({
        kind: "error",
        text: tr("prsloy.undo.failed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      });
    } finally {
      setBusy(false);
      setReloads((n) => n + 1);
    }
  }

  const now = new Date();
  return (
    <>
      <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
        <DialogContent className="max-w-md gap-3 p-4" data-testid="version-history">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-[15px] font-semibold">
              <History className="size-4" strokeWidth={1.75} />
              {tr("features.history.title")}
            </DialogTitle>
            <DialogDescription className="text-[12px] leading-relaxed">
              {tr("features.history.hint")}
            </DialogDescription>
          </DialogHeader>
          {note ? (
            <p
              className="version-history-note"
              data-kind={note.kind}
              role={note.kind === "error" ? "alert" : "status"}
              data-testid="version-history-note"
            >
              {note.text}
            </p>
          ) : null}
          {props.running ? (
            <p className="version-history-note" role="status">
              {tr("prsloy.undo.busy")}
            </p>
          ) : null}
          {!entries ? (
            <p className="version-history-note">{tr("features.history.loading")}</p>
          ) : entries.length === 0 ? (
            <p className="version-history-note" data-testid="version-history-empty">
              {tr("features.history.empty")}
            </p>
          ) : (
            <ol className="version-history-list" data-testid="version-history-list">
              {entries.map((entry) => (
                <li
                  key={entry.id}
                  className="version-history-row"
                  data-testid="version-history-row"
                >
                  <div className="version-history-text">
                    <span className="version-history-what" title={historyWhat(props.locale, entry)}>
                      {historyWhat(props.locale, entry)}
                    </span>
                    <span className="version-history-time">
                      {historyTime(props.locale, entry.createdAt, now)}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="code-preview-tool"
                    data-testid="version-history-restore"
                    disabled={busy || props.running}
                    onClick={() => setAsking(entry)}
                  >
                    <RotateCcw className="size-3.5" strokeWidth={1.75} />
                    {tr("features.history.restore")}
                  </button>
                </li>
              ))}
            </ol>
          )}
          <DialogFooter className="sm:justify-end">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="version-history-close"
              onClick={props.onClose}
            >
              {tr("features.history.close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={asking !== undefined}
        title={tr("features.history.confirmTitle")}
        message={tr("features.history.confirmMessage", {
          what: asking ? historyWhat(props.locale, asking) : "",
        })}
        confirmLabel={tr("features.history.restore")}
        cancelLabel={tr("common.cancel")}
        testId="version-history-confirm"
        onConfirm={() => {
          const target = asking;
          setAsking(undefined);
          if (target) void restore(target);
        }}
        onCancel={() => setAsking(undefined)}
      />
    </>
  );
}
