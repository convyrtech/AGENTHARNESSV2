/**
 * Renders portable extension UI dialogs (select / confirm / input / editor)
 * driven by the promise queue in extension-ui-prompt.ts.
 *
 * #83: more than one question can be in flight (two chats, or an extension asking
 * twice). The first is on screen, the rest wait and are named in a small line so a
 * queued question never looks like a lost one.
 */
import { useEffect, useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { ExtensionUiInputDialog, SECRET_MARK } from "./ExtensionUiInputDialog.tsx";
import { ExtensionUiSelectDialog } from "./ExtensionUiSelectDialog.tsx";
import {
  getPendingExtensionUiDialog,
  getQueuedExtensionUiDialogs,
  parseConfirmArgs,
  parseInputArgs,
  parseSelectArgs,
  settleExtensionUiDialog,
  subscribeExtensionUiDialog,
  type ExtensionUiDialogRequest,
} from "../lib/extension-ui-prompt.ts";
import { t, type Locale } from "../lib/i18n.ts";

export function ExtensionUiHost(props: { locale: Locale }) {
  const [request, setRequest] = useState<ExtensionUiDialogRequest | null>(() =>
    getPendingExtensionUiDialog(),
  );
  const [queued, setQueued] = useState<ExtensionUiDialogRequest[]>(() =>
    getQueuedExtensionUiDialogs(),
  );

  useEffect(() => {
    return subscribeExtensionUiDialog(() => {
      setRequest(getPendingExtensionUiDialog());
      setQueued(getQueuedExtensionUiDialogs());
    });
  }, []);

  const cancelLabel = t(props.locale, "common.cancel");
  const confirmLabel = t(props.locale, "common.confirm");

  if (!request) return null;

  const queueNote =
    queued.length > 0 ? (
      <p className="extension-ui-queue" role="status" data-testid="extension-ui-queue">
        {t(props.locale, "extensionUi.queue", { n: String(queued.length) })}
      </p>
    ) : null;

  if (request.method === "select") {
    const { title, options } = parseSelectArgs(request.args);
    return (
      <>
        <ExtensionUiSelectDialog
          open
          title={title}
          options={options}
          locale={props.locale}
          cancelLabel={cancelLabel}
          onSelect={(value) => settleExtensionUiDialog({ ok: true, value })}
          onCancel={() => settleExtensionUiDialog({ ok: false, value: undefined })}
        />
        {queueNote}
      </>
    );
  }

  if (request.method === "confirm") {
    const { title, message } = parseConfirmArgs(request.args);
    return (
      <>
        <ConfirmDialog
          open
          title={title}
          message={message}
          confirmLabel={confirmLabel}
          cancelLabel={cancelLabel}
          testId="extension-ui-confirm-dialog"
          onConfirm={() => settleExtensionUiDialog({ ok: true, value: true })}
          onCancel={() => settleExtensionUiDialog({ ok: true, value: false })}
        />
        {queueNote}
      </>
    );
  }

  // input | editor — free-text dialog (Electron has no window.prompt).
  const { title, initial } = parseInputArgs(request.args, request.method);
  // The harness's request_secret marks its field `secret:NAME`: a hidden field, never prefilled.
  const secret = request.method === "input" && initial.startsWith(SECRET_MARK);
  return (
    <>
      <ExtensionUiInputDialog
        open
        title={title}
        initialValue={secret ? "" : initial}
        secret={secret}
        multiline={request.method === "editor"}
        locale={props.locale}
        confirmLabel={confirmLabel}
        cancelLabel={cancelLabel}
        testId={
          request.method === "editor" ? "extension-ui-editor-dialog" : "extension-ui-input-dialog"
        }
        onConfirm={(value) => settleExtensionUiDialog({ ok: true, value })}
        onCancel={() => settleExtensionUiDialog({ ok: false, value: undefined })}
      />
      {queueNote}
    </>
  );
}
