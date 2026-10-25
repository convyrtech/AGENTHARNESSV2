/**
 * Chat ⋯ → «Забыть всё, что выучено из этого чата» (research/27 §2, core's `memory.forgetSource`, #14).
 * A confirm first; then «Забыл N записей…» with [Вернуть], which restores exactly what went. Entries
 * learned elsewhere too only lose this chat's quotes, so they are not listed. Shown only when main has
 * the method and the chat has a Pi session id.
 */
import type { MemoryItem } from "@zeno/contracts";
import { BrainCircuit } from "lucide-react";
import { useState, type ReactNode } from "react";
import { t, type Locale } from "../lib/i18n.ts";
import { errorText, forgottenBetween, memoryApi } from "../lib/memory.ts";
import { useShellStore } from "../store/shell-store.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { MenuItem } from "./ui/menu-item.tsx";

type Step =
  | { kind: "idle" }
  | { kind: "ask" }
  | { kind: "done"; gone: MemoryItem[] }
  | { kind: "error"; message: string };

export function useForgetChatMemory(props: { locale: Locale; sessionId: string | undefined }): {
  menuItem: (closeMenu: () => void) => ReactNode;
  dialogs: ReactNode;
} {
  const tr = (key: Parameters<typeof t>[1], vars?: Record<string, string>) =>
    t(props.locale, key, vars);
  const api = memoryApi();
  const workspace = useShellStore((s) => s.snapshot?.cwd);
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const sessionId = props.sessionId;
  const available = Boolean(api?.forgetSource && sessionId);

  async function forget() {
    if (!api?.forgetSource || !sessionId) return;
    try {
      const before = await api.list(workspace);
      const after = await api.forgetSource(sessionId, workspace);
      setStep({ kind: "done", gone: forgottenBetween(before, after) });
    } catch (e) {
      setStep({ kind: "error", message: errorText(e) });
    }
  }

  async function restore(gone: MemoryItem[]) {
    setStep({ kind: "idle" });
    if (!api) return;
    try {
      for (const item of gone) await api.restore(item.id, workspace);
    } catch (e) {
      setStep({ kind: "error", message: errorText(e) });
    }
  }

  const menuItem = (closeMenu: () => void) =>
    available ? (
      <MenuItem
        icon={<BrainCircuit className="size-3.5" strokeWidth={1.75} />}
        label={tr("features.memory.chat.forget")}
        testId="thread-header-forget-memory"
        onClick={() => {
          closeMenu();
          window.setTimeout(() => setStep({ kind: "ask" }), 0);
        }}
      />
    ) : null;

  const done = step.kind === "done" ? step : undefined;
  const dialogs = (
    <>
      <ConfirmDialog
        open={step.kind === "ask"}
        danger
        title={tr("features.memory.chat.forgetTitle")}
        message={tr("features.memory.chat.forgetMessage")}
        confirmLabel={tr("features.memory.chat.forgetConfirm")}
        cancelLabel={tr("common.cancel")}
        testId="forget-chat-memory-confirm"
        onConfirm={() => void forget()}
        onCancel={() => setStep({ kind: "idle" })}
      />
      <ConfirmDialog
        open={Boolean(done)}
        title={
          done?.gone.length
            ? tr("features.memory.chat.forgotCount", { count: String(done.gone.length) })
            : tr("features.memory.chat.forgotNone")
        }
        message={
          done?.gone.length
            ? done.gone.map((item) => `«${item.text}»`).join(", ")
            : tr("features.memory.chat.forgotNoneHint")
        }
        confirmLabel={done?.gone.length ? tr("features.memory.restore") : tr("common.confirm")}
        cancelLabel={tr("features.memory.chat.done")}
        testId="forget-chat-memory-result"
        onConfirm={() => (done?.gone.length ? void restore(done.gone) : setStep({ kind: "idle" }))}
        onCancel={() => setStep({ kind: "idle" })}
      />
      <ConfirmDialog
        open={step.kind === "error"}
        title={tr("features.memory.chat.forgetTitle")}
        message={step.kind === "error" ? tr("features.memory.failed", { error: step.message }) : ""}
        confirmLabel={tr("common.confirm")}
        cancelLabel={tr("common.cancel")}
        testId="forget-chat-memory-error"
        onConfirm={() => setStep({ kind: "idle" })}
        onCancel={() => setStep({ kind: "idle" })}
      />
    </>
  );
  return { menuItem, dialogs };
}
