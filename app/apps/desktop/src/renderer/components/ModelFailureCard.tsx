/**
 * A model turn that failed, said plainly with one thing to do: «Повторить» (resend the same
 * prompt), «Пополнить» (the PRSLOY cabinet) or «Изменить ключ» (Settings → Аккаунт). The raw
 * error stays folded away under «Подробности».
 */
import { useEffect, useState } from "react";
import { ChevronRight, CircleAlert, KeyRound, RotateCcw, Wallet } from "lucide-react";
import { t, type Locale } from "../lib/i18n.ts";
import {
  failureAction,
  failureActionLabelKey,
  failureHintKey,
  failureKind,
  failureTitleKey,
  type FailureKind,
} from "../lib/model-failure.ts";
import { useShellStore } from "../store/shell-store.ts";
import { cn } from "../lib/utils.ts";
import { PRSLOY_KEY_URL } from "./prsloy/FirstRunGate.tsx";

export function ModelFailureCard(props: {
  locale: Locale;
  detail: string;
  /** The host's failure category (`message.failed.code`), when the event carried one. */
  code?: string | undefined;
  /** Set when the row already says what failed (an Agent Host crash). */
  kind?: FailureKind | undefined;
  /** Resend this turn's prompt; absent when there is none to resend. */
  onRetry?: (() => void) | undefined;
  disabled?: boolean | undefined;
}) {
  const [open, setOpen] = useState(false);
  const kind = props.kind ?? failureKind(props.code, props.detail);
  const action = failureAction(kind);
  const title = t(props.locale, failureTitleKey(kind));
  const hintKey = failureHintKey(kind);
  // A bare 404 from a wrong address also reads as a missing model: with «Другой сервер» set,
  // the address is the other suspect.
  const [customServer, setCustomServer] = useState(false);
  useEffect(() => {
    if (kind !== "model") return;
    let alive = true;
    void window.zeno.prsloy
      .getState()
      .then((state) => alive && setCustomServer(state.baseUrl !== state.defaultBaseUrl))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [kind]);
  // The gateway's own drop already says «Связь с моделью оборвалась»; nothing more to unfold.
  const detail = props.detail.trim() === title ? "" : props.detail;
  const run =
    action === "topUp"
      ? () => void window.zeno.workspace.openExternal(PRSLOY_KEY_URL).catch(() => undefined)
      : action === "changeKey"
        ? () => {
            const shell = useShellStore.getState();
            shell.setSettingsSection("account");
            shell.setView("settings");
          }
        : props.onRetry;
  const Icon = action === "topUp" ? Wallet : action === "changeKey" ? KeyRound : RotateCcw;
  return (
    <div
      className="model-failure"
      data-kind="system"
      data-failure={kind}
      data-testid="model-failure"
      role="alert"
    >
      <div className="model-failure-head">
        <CircleAlert className="size-4 shrink-0" strokeWidth={1.75} />
        <span className="model-failure-title">{title}</span>
        {run ? (
          <button
            type="button"
            className="model-failure-retry"
            data-testid={action === "retry" ? "model-failure-retry" : `model-failure-${action}`}
            disabled={action === "retry" && props.disabled}
            onClick={run}
          >
            <Icon className="size-3.5" strokeWidth={1.75} />
            {t(props.locale, failureActionLabelKey(kind))}
          </button>
        ) : null}
      </div>
      {hintKey ? <p className="model-failure-hint">{t(props.locale, hintKey)}</p> : null}
      {customServer ? (
        <p className="model-failure-hint" data-testid="model-failure-server">
          {t(props.locale, "failure.model.server")}
        </p>
      ) : null}
      {detail ? (
        <>
          <button
            type="button"
            className="model-failure-toggle"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            <ChevronRight
              className={cn("size-3.5 transition-transform", open && "rotate-90")}
              strokeWidth={2}
            />
            {t(props.locale, "system.details")}
          </button>
          {open ? <pre className="model-failure-detail">{detail}</pre> : null}
        </>
      ) : null}
    </div>
  );
}
