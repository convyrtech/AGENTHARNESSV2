/**
 * Memory v2 cards (research/24 §3.6): what the harness noticed in the owner's words by itself.
 * «Заметил и запомнил: …» · [Забыть] [Закрепить] (several: «Запомнил N» · [Показать]);
 * «Обновил: было «…», стало «…»» · [Вернуть]; when the replaced entry was pinned, a question:
 * «Раньше вы просили «…». Теперь — «…»?» · [Да, теперь так] [Нет, как раньше].
 */
import type { MemoryAutoCardDetails } from "@zeno/contracts";
import { Brain, Pin, RotateCcw } from "lucide-react";
import { useState, type ReactNode } from "react";
import { t, type Locale } from "../lib/i18n.ts";
import { errorText, memoryApi, parseAutoDetails, parseUpdatedDetails } from "../lib/memory.ts";
import { useShellStore } from "../store/shell-store.ts";

type Tr = (key: Parameters<typeof t>[1], vars?: Record<string, string>) => string;

function CardShell(props: {
  kind: string;
  title: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      className="model-failure harness-card memory-card"
      data-kind="system"
      data-memory={props.kind}
      data-testid="memory-card"
    >
      <div className="model-failure-head">
        <Brain className="size-4 shrink-0" strokeWidth={1.75} />
        <span className="model-failure-title">{props.title}</span>
        {props.actions}
      </div>
      {props.children}
    </div>
  );
}

function ActionButton(props: {
  testId: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="model-failure-retry"
      data-testid={props.testId}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

/** One noticed entry with its own [Забыть] [Закрепить]. */
function AutoEntry(props: {
  tr: Tr;
  item: MemoryAutoCardDetails["items"][number];
  inline: boolean;
}) {
  const { tr, item } = props;
  const api = memoryApi();
  const workspace = useShellStore((s) => s.snapshot?.cwd);
  const [state, setState] = useState<"idle" | "forgot" | "pinned">("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function run(call: () => Promise<unknown>, next: "forgot" | "pinned") {
    setBusy(true);
    setError(undefined);
    try {
      await call();
      setState(next);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const text = props.inline ? tr("features.memory.auto.one", { text: item.text }) : item.text;
  const actions =
    api && state === "idle" ? (
      <>
        <ActionButton
          testId="memory-auto-forget"
          disabled={busy}
          onClick={() => void run(() => api.forget(item.id, workspace), "forgot")}
        >
          {tr("features.memory.forget")}
        </ActionButton>
        <ActionButton
          testId="memory-auto-pin"
          disabled={busy}
          onClick={() => void run(() => api.pin(item.id, true, workspace), "pinned")}
        >
          <Pin className="size-3.5" strokeWidth={1.75} />
          {tr("features.memory.pin")}
        </ActionButton>
      </>
    ) : state !== "idle" ? (
      <span className="memory-auto-done" role="status">
        {tr(state === "forgot" ? "features.memory.card.forgotDone" : "features.memory.pinned")}
      </span>
    ) : null;
  return (
    <div className="memory-auto-entry" data-testid="memory-auto-entry">
      <div className="memory-auto-entry-head">
        <span className="memory-auto-text">{text}</span>
        {actions}
      </div>
      {item.quote ? (
        <p className="model-failure-hint">{tr("features.memory.quote", { quote: item.quote })}</p>
      ) : null}
      {error ? (
        <p className="model-failure-hint" role="alert">
          {tr("features.memory.failed", { error })}
        </p>
      ) : null}
    </div>
  );
}

export function MemoryAutoCard(props: { locale: Locale; details: unknown; text: string }) {
  const tr: Tr = (key, vars) => t(props.locale, key, vars);
  const items = parseAutoDetails(props.details);
  const [open, setOpen] = useState(false);
  if (items.length === 0) return <CardShell kind="auto" title={props.text.trim()} />;
  if (items.length === 1) {
    return (
      <CardShell kind="auto" title={null}>
        <AutoEntry tr={tr} item={items[0]!} inline />
      </CardShell>
    );
  }
  return (
    <CardShell
      kind="auto"
      title={tr("features.memory.auto.many", { count: String(items.length) })}
      actions={
        <ActionButton testId="memory-auto-show" onClick={() => setOpen((v) => !v)}>
          {tr(open ? "features.memory.auto.hide" : "features.memory.auto.show")}
        </ActionButton>
      }
    >
      {open ? (
        <div className="memory-auto-list">
          {items.map((item) => (
            <AutoEntry key={item.id} tr={tr} item={item} inline={false} />
          ))}
        </div>
      ) : null}
    </CardShell>
  );
}

export function MemoryUpdatedCard(props: { locale: Locale; details: unknown; text: string }) {
  const tr: Tr = (key, vars) => t(props.locale, key, vars);
  const details = parseUpdatedDetails(props.details);
  const api = memoryApi();
  const workspace = useShellStore((s) => s.snapshot?.cwd);
  const [state, setState] = useState<"idle" | "reverted" | "kept">("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  if (!details) return <CardShell kind="updated" title={props.text.trim()} />;

  async function decide(choice: "reverted" | "kept") {
    if (!api || !details) return;
    setBusy(true);
    setError(undefined);
    try {
      // The old entry was pinned: the new one replaces it, so it stays pinned.
      if (choice === "kept") await api.pin(details.id, true, workspace);
      else await api.revert(details.opId, workspace);
      setState(choice);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const vars = { before: details.before, after: details.after };
  const title =
    state === "reverted"
      ? tr("features.memory.reverted")
      : state === "kept"
        ? tr("features.memory.kept")
        : tr(details.pinned ? "features.memory.updatedAsk" : "features.memory.updated", vars);
  const actions =
    state !== "idle" || !api ? null : details.pinned ? (
      <>
        <ActionButton
          testId="memory-updated-yes"
          disabled={busy}
          onClick={() => void decide("kept")}
        >
          {tr("features.memory.updatedYes")}
        </ActionButton>
        <ActionButton
          testId="memory-updated-no"
          disabled={busy}
          onClick={() => void decide("reverted")}
        >
          {tr("features.memory.updatedNo")}
        </ActionButton>
      </>
    ) : (
      <ActionButton
        testId="memory-updated-revert"
        disabled={busy}
        onClick={() => void decide("reverted")}
      >
        <RotateCcw className="size-3.5" strokeWidth={1.75} />
        {tr("features.memory.restore")}
      </ActionButton>
    );
  return (
    <CardShell kind="updated" title={title} actions={actions}>
      {error ? (
        <p className="model-failure-hint" role="alert">
          {tr("features.memory.failed", { error })}
        </p>
      ) : null}
    </CardShell>
  );
}
