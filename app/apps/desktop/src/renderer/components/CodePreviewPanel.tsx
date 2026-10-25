/**
 * «Код» side panel: the page or local server a turn produced, in the same sandboxed frame as
 * the «Дизайн» preview, with «Компьютер / Телефон», «Обновить» and «Открыть в браузере».
 */
import type { CodePreviewResult } from "@zeno/contracts";
import {
  CircleAlert,
  Crop,
  Download,
  ExternalLink,
  MousePointerClick,
  RotateCw,
  X,
} from "lucide-react";
import { type RefObject, useEffect, useRef, useState } from "react";
import { closeCodePreview, useCodePreview } from "../lib/code-preview-store.ts";
import { t, type Locale, type MessageKey } from "../lib/i18n.ts";
import {
  addPageError,
  appendToDraft,
  type BridgeMessage,
  type PageError,
  pageErrorLine,
  pageErrorsPrompt,
  pickedLabel,
  pickedPrompt,
} from "../lib/preview-bridge.ts";
import { useShellStore } from "../store/shell-store.ts";
import { UNDO_LOG_CHANGED_EVENT } from "../lib/undo-log.ts";
import { afterPaint, type Rect } from "../lib/preview-capture.ts";
import { exportProjectZip, type ProjectZipNote } from "../lib/project-zip.ts";
import { previewTargetLabel } from "../lib/turn-preview.ts";
import { PreviewCaptureOverlay } from "./PreviewCaptureOverlay.tsx";
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
  /** «Починить»: sends the page's errors to the agent, the same way as «Повторить». */
  onSend?: (text: string) => void;
  /** «Снять часть страницы»: the snapshot's file goes into the composer's attachments. */
  onAttach?: (paths: string[]) => void;
}) {
  const preview = useCodePreview();
  const [result, setResult] = useState<CodePreviewResult | undefined>();
  const [device, setDevice] = useState<PreviewDevice>("desktop");
  const [reloads, setReloads] = useState(0);
  /** The page answered from the injected script; an agent's own server never does. */
  const [bridgeReady, setBridgeReady] = useState(false);
  const [picking, setPicking] = useState(false);
  const [pickedWhat, setPickedWhat] = useState<string | undefined>();
  const [errors, setErrors] = useState<PageError[]>([]);
  const [errorsHidden, setErrorsHidden] = useState(false);
  const [zipNote, setZipNote] = useState<ProjectZipNote>();
  const [zipping, setZipping] = useState(false);
  const [capturing, setCapturing] = useState(false);

  // The agent changed the page (a turn ended) or «Откатить» put the files back: show what is on disk now,
  // not the page from before (the first-hour walkthrough: «Сделай фон тёмным» left the preview white).
  const running = useShellStore((s) => s.running);
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) setReloads((n) => n + 1);
    wasRunning.current = running;
  }, [running]);
  useEffect(() => {
    const reload = () => setReloads((n) => n + 1);
    window.addEventListener(UNDO_LOG_CHANGED_EVENT, reload);
    return () => window.removeEventListener(UNDO_LOG_CHANGED_EVENT, reload);
  }, []);

  // A new page or a reload starts clean.
  useEffect(() => {
    setBridgeReady(false);
    setPicking(false);
    setPickedWhat(undefined);
    setErrors([]);
    setErrorsHidden(false);
    setZipNote(undefined);
    setCapturing(false);
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

  async function capture(rect: Rect) {
    setCapturing(false);
    // The frame layer must be gone from the window before main takes the picture.
    await afterPaint();
    const result = await window.zeno.features
      .capturePreview(rect)
      .catch(() => ({ ok: false as const }));
    if (result.ok) props.onAttach?.([result.path]);
    setZipNote({
      kind: result.ok ? "ok" : "error",
      text: tr(result.ok ? "features.capture.done" : "features.capture.failed"),
    });
  }

  function onBridgeMessage(message: BridgeMessage) {
    if (message.type === "ready") setBridgeReady(true);
    else if (message.type === "error") setErrors((list) => addPageError(list, message));
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
      {result?.ok ? (
        <div className="code-preview-tools" data-testid="code-preview-tools">
          {bridgeReady && props.composerRef ? (
            <button
              type="button"
              className="code-preview-tool"
              data-active={picking ? "true" : "false"}
              aria-pressed={picking}
              data-testid="code-preview-pick"
              onClick={() => {
                setPickedWhat(undefined);
                setCapturing(false);
                setPicking((on) => !on);
              }}
            >
              <MousePointerClick className="size-3.5" strokeWidth={1.75} />
              {tr(picking ? "features.pick.cancel" : "features.pick.start")}
            </button>
          ) : null}
          {props.onAttach ? (
            <button
              type="button"
              className="code-preview-tool"
              data-active={capturing ? "true" : "false"}
              aria-pressed={capturing}
              data-testid="code-preview-capture"
              onClick={() => {
                setPicking(false);
                setZipNote(undefined);
                setCapturing((on) => !on);
              }}
            >
              <Crop className="size-3.5" strokeWidth={1.75} />
              {tr(capturing ? "features.capture.cancel" : "features.capture.start")}
            </button>
          ) : null}
          {preview.workspacePath ? (
            <button
              type="button"
              className="code-preview-tool"
              data-testid="code-preview-zip"
              disabled={zipping}
              onClick={() => {
                setZipping(true);
                setZipNote(undefined);
                void exportProjectZip(props.locale, preview.workspacePath).then((note) => {
                  setZipping(false);
                  setZipNote(note);
                });
              }}
            >
              <Download className="size-3.5" strokeWidth={1.75} />
              {tr("features.zip.action")}
            </button>
          ) : null}
          {zipNote && !picking ? (
            <span
              className="code-preview-tools-note"
              role={zipNote.kind === "error" ? "alert" : "status"}
              data-kind={zipNote.kind}
              data-testid="code-preview-zip-note"
            >
              {zipNote.text}
            </span>
          ) : picking || pickedWhat ? (
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
      {result?.ok && errors.length > 0 && !errorsHidden ? (
        <div className="code-preview-errors" role="alert" data-testid="code-preview-errors">
          <CircleAlert className="code-preview-errors-icon size-4" strokeWidth={1.75} />
          <div className="code-preview-errors-text">
            <strong>
              {errors.length === 1
                ? tr("features.errors.one")
                : t(props.locale, "features.errors.many", { count: String(errors.length) })}
            </strong>
            <span title={errors.map((e) => pageErrorLine(props.locale, e)).join("\n")}>
              {pageErrorLine(props.locale, errors[0]!)}
            </span>
          </div>
          {props.onSend ? (
            <button
              type="button"
              className="code-preview-tool"
              data-testid="code-preview-fix"
              onClick={() => {
                props.onSend?.(pageErrorsPrompt(props.locale, errors));
                setErrorsHidden(true);
              }}
            >
              {tr("features.errors.fix")}
            </button>
          ) : null}
          <button
            type="button"
            className="code-preview-icon"
            data-testid="code-preview-errors-hide"
            title={tr("features.errors.hide")}
            aria-label={tr("features.errors.hide")}
            onClick={() => setErrorsHidden(true)}
          >
            <X className="size-4" strokeWidth={1.75} />
          </button>
        </div>
      ) : null}
      {result?.ok ? (
        <div className="code-preview-stage-wrap">
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
          {capturing ? (
            <PreviewCaptureOverlay
              hint={tr("features.capture.hint")}
              onPicked={(rect) => void capture(rect)}
              onCancel={() => setCapturing(false)}
            />
          ) : null}
        </div>
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
