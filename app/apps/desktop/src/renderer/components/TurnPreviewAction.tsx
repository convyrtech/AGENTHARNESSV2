/** «Открыть превью» under a finished «Код» turn that wrote a page or started a local server. */
import type { CodePreviewTarget } from "@zeno/contracts";
import { Eye } from "lucide-react";
import { openCodePreview } from "../lib/code-preview-store.ts";
import { t, type Locale } from "../lib/i18n.ts";

export function TurnPreviewAction(props: {
  locale: Locale;
  target: CodePreviewTarget;
  workspacePath: string | undefined;
}) {
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
