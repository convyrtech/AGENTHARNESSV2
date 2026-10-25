/**
 * «Код» side panel: the page or local server a turn produced, in the same sandboxed frame as
 * the «Дизайн» preview, with «Компьютер / Телефон», «Обновить» and «Открыть в браузере».
 */
import type { CodePreviewResult } from "@zeno/contracts";
import { ExternalLink, RotateCw, X } from "lucide-react";
import { useEffect, useState } from "react";
import { closeCodePreview, useCodePreview } from "../lib/code-preview-store.ts";
import { t, type Locale, type MessageKey } from "../lib/i18n.ts";
import { previewTargetLabel } from "../lib/turn-preview.ts";
import { type PreviewDevice, PreviewDeviceSwitch, PreviewStage } from "./PreviewFrame.tsx";

/** Pages keep their own storage and forms; navigation is still held to loopback by main. */
const CODE_PREVIEW_SANDBOX = "allow-scripts allow-same-origin allow-forms";

function failureKey(result: CodePreviewResult | undefined): MessageKey | undefined {
  if (!result || result.ok) return undefined;
  if (result.reason === "down") return "codePreview.down";
  if (result.reason === "missing") return "codePreview.missing";
  return "codePreview.failed";
}

export function CodePreviewPanel(props: { locale: Locale; sessionKey: string }) {
  const preview = useCodePreview();
  const [result, setResult] = useState<CodePreviewResult | undefined>();
  const [device, setDevice] = useState<PreviewDevice>("desktop");
  const [reloads, setReloads] = useState(0);

  // Another chat: its turns' previews are not this one's.
  useEffect(() => closeCodePreview, [props.sessionKey]);

  useEffect(() => {
    if (!preview) return;
    let alive = true;
    setResult(undefined);
    void window.zeno.codePreview
      .open(preview.target, preview.workspacePath)
      .then((next) => alive && setResult(next))
      .catch(() => alive && setResult({ ok: false, reason: "missing" }));
    return () => {
      alive = false;
    };
  }, [preview, reloads]);

  if (!preview) return null;
  const tr = (key: MessageKey) => t(props.locale, key);
  const failed = failureKey(result);
  return (
    <aside
      className="code-preview-panel"
      data-testid="code-preview-panel"
      aria-label={tr("codePreview.title")}
    >
      <header className="code-preview-head">
        <span className="code-preview-title" title={previewTargetLabel(preview.target)}>
          {previewTargetLabel(preview.target)}
        </span>
        <PreviewDeviceSwitch
          locale={props.locale}
          device={device}
          onChange={setDevice}
          testIdPrefix="code-preview"
        />
        <button
          type="button"
          className="code-preview-icon"
          data-testid="code-preview-reload"
          title={tr("codePreview.reload")}
          aria-label={tr("codePreview.reload")}
          onClick={() => setReloads((n) => n + 1)}
        >
          <RotateCw className="size-4" strokeWidth={1.75} />
        </button>
        <button
          type="button"
          className="code-preview-icon"
          data-testid="code-preview-external"
          title={tr("codePreview.openExternal")}
          aria-label={tr("codePreview.openExternal")}
          onClick={() =>
            void window.zeno.codePreview
              .openExternal(preview.target, preview.workspacePath)
              .catch(() => false)
          }
        >
          <ExternalLink className="size-4" strokeWidth={1.75} />
        </button>
        <button
          type="button"
          className="code-preview-icon"
          data-testid="code-preview-close"
          title={tr("codePreview.close")}
          aria-label={tr("codePreview.close")}
          onClick={closeCodePreview}
        >
          <X className="size-4" strokeWidth={1.75} />
        </button>
      </header>
      {result?.ok ? (
        <PreviewStage
          key={`${preview.nonce}:${reloads}`}
          locale={props.locale}
          url={result.url}
          device={device}
          sandbox={CODE_PREVIEW_SANDBOX}
          testId="code-preview-frame"
          className="code-preview-stage"
        />
      ) : (
        <p
          className="code-preview-note"
          role={failed ? "alert" : "status"}
          data-testid="code-preview-note"
        >
          {tr(failed ?? "codePreview.loading")}
        </p>
      )}
    </aside>
  );
}
