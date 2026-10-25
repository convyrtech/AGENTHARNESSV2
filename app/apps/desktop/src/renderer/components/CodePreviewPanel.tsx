/**
 * «Код» side panel: the page or local server a turn produced, in the same sandboxed frame as
 * the «Дизайн» preview, with «Компьютер / Телефон», «Обновить» and «Открыть в браузере».
 */
import type { CodePreviewResult } from "@zeno/contracts";
import { ExternalLink, MousePointerClick, RotateCw, X } from "lucide-react";
import { type RefObject, useEffect, useState } from "react";
import { closeCodePreview, useCodePreview } from "../lib/code-preview-store.ts";
import { t, type Locale, type MessageKey } from "../lib/i18n.ts";
import {
  appendToDraft,
  type BridgeMessage,
  pickedLabel,
  pickedPrompt,
} from "../lib/preview-bridge.ts";
import { useShellStore } from "../store/shell-store.ts";
import { previewTargetLabel } from "../lib/turn-preview.ts";
import { type PreviewDevice, PreviewDeviceSwitch, PreviewStage } from "./PreviewFrame.tsx";
import "./code-preview-features.css";

/** Pages keep their own storage and forms; navigation is still held to loopback by main. */
const CODE_PREVIEW_SANDBOX = "allow-scripts allow-same-origin allow-forms";

function failureKey(result: CodePreviewResult | undefined): MessageKey | undefined {
  if (!result || result.ok) return undefined;
  if (result.reason === "down") return "codePreview.down";
  if (result.reason === "missing") return "codePreview.missing";
  return "codePreview.failed";
}

export function CodePreviewPanel(props: {
  locale: Locale;
  sessionKey: string;
  /** The chat's composer: «Выбрать на странице» puts the picked place there to finish. */
  composerRef?: RefObject<HTMLTextAreaElement | null>;
}) {
  const preview = useCodePreview();
  const [result, setResult] = useState<CodePreviewResult | undefined>();
  const [device, setDevice] = useState<PreviewDevice>("desktop");
  const [reloads, setReloads] = useState(0);
  /** The page answered from the injected script; an agent's own server never does. */
  const [bridgeReady, setBridgeReady] = useState(false);
  const [picking, setPicking] = useState(false);
  const [pickedWhat, setPickedWhat] = useState<string | undefined>();

  // A new page or a reload starts clean.
  useEffect(() => {
    setBridgeReady(false);
    setPicking(false);
    setPickedWhat(undefined);
  }, [preview, reloads]);

  // Esc cancels picking wherever focus is: the frame tells us itself, the app hears it here.
  useEffect(() => {
    if (!picking) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPicking(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [picking]);

  function insertIntoComposer(block: string) {
    const { prompt, setPrompt } = useShellStore.getState();
    setPrompt(appendToDraft(prompt, block));
    requestAnimationFrame(() => {
      const el = props.composerRef?.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }

  function onBridgeMessage(message: BridgeMessage) {
    if (message.type === "ready") setBridgeReady(true);
    else if (message.type === "pick-cancel") setPicking(false);
    else if (message.type === "picked") {
      setPicking(false);
      setPickedWhat(pickedLabel(message));
      insertIntoComposer(pickedPrompt(props.locale, message));
    }
  }

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
      {result?.ok && bridgeReady && props.composerRef ? (
        <div className="code-preview-tools" data-testid="code-preview-tools">
          <button
            type="button"
            className="code-preview-tool"
            data-active={picking ? "true" : "false"}
            aria-pressed={picking}
            data-testid="code-preview-pick"
            onClick={() => {
              setPickedWhat(undefined);
              setPicking((on) => !on);
            }}
          >
            <MousePointerClick className="size-3.5" strokeWidth={1.75} />
            {tr(picking ? "features.pick.cancel" : "features.pick.start")}
          </button>
          {picking || pickedWhat ? (
            <span
              className="code-preview-tools-note"
              role="status"
              data-testid="code-preview-pick-note"
            >
              {picking
                ? tr("features.pick.hint")
                : t(props.locale, "features.pick.picked", { what: pickedWhat ?? "" })}
            </span>
          ) : null}
        </div>
      ) : null}
      {result?.ok ? (
        <PreviewStage
          key={`${preview.nonce}:${reloads}`}
          locale={props.locale}
          url={result.url}
          device={device}
          sandbox={CODE_PREVIEW_SANDBOX}
          testId="code-preview-frame"
          className="code-preview-stage"
          bridge={{ picking, onMessage: onBridgeMessage }}
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
