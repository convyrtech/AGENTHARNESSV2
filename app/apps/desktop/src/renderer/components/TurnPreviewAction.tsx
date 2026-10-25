/** «Открыть превью» under a finished «Код» turn that wrote a page or started a local server. */
import type { CodePreviewTarget } from "@zeno/contracts";
import { Eye } from "lucide-react";
import { useEffect, useState } from "react";
import { openCodePreview } from "../lib/code-preview-store.ts";
import { t, type Locale } from "../lib/i18n.ts";
import { loadUndoOutcome, UNDO_LOG_CHANGED_EVENT } from "../lib/undo-log.ts";

function undone(snapshotId: string | undefined): boolean {
  return snapshotId ? loadUndoOutcome(snapshotId)?.kind === "undone" : false;
}

export function TurnPreviewAction(props: {
  locale: Locale;
  target: CodePreviewTarget;
  workspacePath: string | undefined;
  /** The turn's undo snapshot: a page the owner rolled back is gone, so nothing to preview. */
  snapshotId?: string | undefined;
}) {
  const [hidden, setHidden] = useState(() => undone(props.snapshotId));
  useEffect(() => {
    setHidden(undone(props.snapshotId));
    const sync = () => setHidden(undone(props.snapshotId));
    window.addEventListener(UNDO_LOG_CHANGED_EVENT, sync);
    return () => window.removeEventListener(UNDO_LOG_CHANGED_EVENT, sync);
  }, [props.snapshotId]);
  if (hidden) return null;
  return (
    <button
      type="button"
      className="turn-undo-btn"
      data-testid="turn-preview-btn"
      onClick={() => openCodePreview(props.target, props.workspacePath)}
    >
      <Eye className="size-3.5" strokeWidth={1.75} />
      {t(props.locale, "codePreview.open")}
    </button>
  );
}
