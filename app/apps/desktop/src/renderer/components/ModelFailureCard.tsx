/**
 * A model turn that failed mid-way: «Связь с моделью оборвалась», «Повторить» (resends the
 * same prompt) and the raw error folded away under «Подробности».
 */
import { useState } from "react";
import { ChevronRight, CircleAlert, RotateCcw } from "lucide-react";
import { t, type Locale } from "../lib/i18n.ts";
import { cn } from "../lib/utils.ts";

export function ModelFailureCard(props: {
  locale: Locale;
  detail: string;
  /** Resend this turn's prompt; absent when there is none to resend. */
  onRetry?: (() => void) | undefined;
  disabled?: boolean | undefined;
}) {
  const [open, setOpen] = useState(false);
  const title = t(props.locale, "system.responseFailed");
  // The gateway's own drop already says «Связь с моделью оборвалась»; nothing more to unfold.
  const detail = props.detail.trim() === title ? "" : props.detail;
  return (
    <div className="model-failure" data-kind="system" data-testid="model-failure" role="alert">
      <div className="model-failure-head">
        <CircleAlert className="size-4 shrink-0" strokeWidth={1.75} />
        <span className="model-failure-title">{title}</span>
        {props.onRetry ? (
          <button
            type="button"
            className="model-failure-retry"
            data-testid="model-failure-retry"
            disabled={props.disabled}
            onClick={props.onRetry}
          >
            <RotateCcw className="size-3.5" strokeWidth={1.75} />
            {t(props.locale, "system.retry.action")}
          </button>
        ) : null}
      </div>
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
