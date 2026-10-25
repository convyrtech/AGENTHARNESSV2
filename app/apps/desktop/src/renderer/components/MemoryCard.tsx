/**
 * The harness's memory cards in the chat (research/18 §6.7, STATUS-harness S4):
 * «Запомнил: …» · [Забыть] [Изменить]; «Забыл.» · [Вернуть] for 10 s; «Память заполнена.
 * Что забыть?» · [Открыть память]; a refusal (password or key) without buttons. Forgetting
 * and restoring go through main (`window.zeno.memory`); without it only «Изменить» and
 * «Открыть память» are offered.
 */
import { Brain, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { t, type Locale } from "../lib/i18n.ts";
import {
  errorText,
  findEntryId,
  memoryApi,
  memoryCardId,
  type MemoryCardKind,
  restoreLeftMs,
  RESTORE_WINDOW_MS,
  savedCardText,
} from "../lib/memory.ts";
import { useShellStore } from "../store/shell-store.ts";
import { MemoryAutoCard, MemoryConfirmCard, MemoryUpdatedCard } from "./MemoryAutoCards.tsx";

type State =
  | { kind: "card" }
  | { kind: "forgotten"; id: string; until: number }
  | { kind: "restored" }
  | { kind: "error"; message: string };

function focusComposer() {
  requestAnimationFrame(() => {
    const input = document.querySelector<HTMLTextAreaElement>('[data-testid="prompt-input"]');
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  });
}

export function MemoryCard(props: {
  locale: Locale;
  kind: MemoryCardKind;
  text: string;
  details?: unknown;
  timestamp?: string | undefined;
}) {
  if (props.kind === "auto") {
    return <MemoryAutoCard locale={props.locale} details={props.details} text={props.text} />;
  }
  if (props.kind === "confirm") {
    return <MemoryConfirmCard locale={props.locale} details={props.details} text={props.text} />;
  }
  if (props.kind === "updated") {
    return <MemoryUpdatedCard locale={props.locale} details={props.details} text={props.text} />;
  }
  return <MemoryRequestCard {...props} />;
}

/** The cards of memory «по просьбе» (research/18 §6.7): saved, forgot, full, refused. */
function MemoryRequestCard(props: {
  locale: Locale;
  kind: MemoryCardKind;
  text: string;
  details?: unknown;
  timestamp?: string | undefined;
}) {
  const tr = (key: Parameters<typeof t>[1], vars?: Record<string, string>) =>
    t(props.locale, key, vars);
  const api = memoryApi();
  const workspace = useShellStore((s) => s.snapshot?.cwd);
  const [state, setState] = useState<State>(() => {
    // A «Забыл.» card the harness showed offers «Вернуть» for its first ten seconds.
    const id = memoryCardId(props.details);
    const left = restoreLeftMs(props.timestamp, Date.now());
    return props.kind === "forgot" && id && left > 0
      ? { kind: "forgotten", id, until: Date.now() + left }
      : { kind: "card" };
  });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (state.kind !== "forgotten") return;
    const timer = window.setTimeout(
      () => setState({ kind: "card" }),
      Math.max(0, state.until - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [state]);

  const savedText = savedCardText(props.text);
  const project = props.text.startsWith("Запомнил для этого проекта:");

  async function forget() {
    if (!api) return;
    setBusy(true);
    try {
      let id = memoryCardId(props.details);
      if (!id) id = findEntryId(await api.list(workspace), savedText);
      if (!id) throw new Error(tr("features.memory.empty"));
      await api.forget(id, workspace);
      setState({ kind: "forgotten", id, until: Date.now() + RESTORE_WINDOW_MS });
    } catch (error) {
      setState({ kind: "error", message: errorText(error) });
    } finally {
      setBusy(false);
    }
  }

  async function restore(id: string) {
    if (!api) return;
    setBusy(true);
    try {
      await api.restore(id, workspace);
      setState({ kind: "restored" });
    } catch (error) {
      setState({ kind: "error", message: errorText(error) });
    } finally {
      setBusy(false);
    }
  }

  const button = (label: string, testId: string, onClick: () => void, icon = false) => (
    <button
      type="button"
      className="model-failure-retry"
      data-testid={testId}
      disabled={busy}
      onClick={onClick}
    >
      {icon ? <RotateCcw className="size-3.5" strokeWidth={1.75} /> : null}
      {label}
    </button>
  );

  const title =
    state.kind === "forgotten"
      ? tr("features.memory.card.forgotDone")
      : state.kind === "restored"
        ? tr("features.memory.card.restored")
        : props.text.trim();

  return (
    <div
      className="model-failure harness-card memory-card"
      data-kind="system"
      data-memory={props.kind}
      data-testid="memory-card"
    >
      <div className="model-failure-head">
        <Brain className="size-4 shrink-0" strokeWidth={1.75} />
        <span className="model-failure-title">{title}</span>
        {state.kind === "forgotten" && api
          ? button(
              tr("features.memory.restore"),
              "memory-card-restore",
              () => void restore(state.id),
              true,
            )
          : null}
        {state.kind === "card" && props.kind === "saved" && api
          ? button(tr("features.memory.forget"), "memory-card-forget", () => void forget())
          : null}
        {state.kind === "card" && props.kind === "saved" && !project
          ? button(tr("features.memory.card.edit"), "memory-card-edit", () => {
              useShellStore
                .getState()
                .setPrompt(tr("features.memory.card.editPrompt", { text: savedText }));
              focusComposer();
            })
          : null}
        {props.kind === "full"
          ? button(tr("features.memory.card.open"), "memory-card-open", () => {
              const store = useShellStore.getState();
              store.setSettingsSection("memory");
              store.setView("settings");
            })
          : null}
      </div>
      {state.kind === "error" ? (
        <p className="model-failure-hint" role="alert">
          {tr("features.memory.failed", { error: state.message })}
        </p>
      ) : null}
    </div>
  );
}
