/**
 * «Не получилось» (research/24 §4.2, §4.5): the harness's honest exit, `report_blocker`, as a
 * card in the chat. Three plain lines — what did not work, why (the code checked it), what the
 * owner can do — and buttons: ready answers that send at once, and «Ответить своими словами».
 */
import { CircleSlash } from "lucide-react";
import { parseBlockerDetails } from "../lib/blocker-card.ts";
import { t, type Locale } from "../lib/i18n.ts";
import { useShellStore } from "../store/shell-store.ts";

export function BlockerCard(props: {
  locale: Locale;
  text: string;
  details?: unknown;
  onSend?: ((text: string) => void) | undefined;
  disabled?: boolean | undefined;
}) {
  const tr = (key: Parameters<typeof t>[1], vars?: Record<string, string>) =>
    t(props.locale, key, vars);
  const d = parseBlockerDetails(props.details);
  return (
    <div
      className="model-failure harness-card blocker-card"
      data-kind="system"
      data-testid="blocker-card"
      role="group"
      aria-label={d ? tr("features.blocker.what", { text: d.what }) : props.text.trim()}
    >
      <div className="model-failure-head">
        <CircleSlash className="size-4 shrink-0" strokeWidth={1.75} />
        <span className="model-failure-title">
          {d ? tr("features.blocker.what", { text: d.what }) : props.text.trim()}
        </span>
      </div>
      {d ? (
        <>
          <p className="model-failure-hint" data-testid="blocker-why">
            {tr("features.blocker.why", { text: d.why })}
          </p>
          <p className="model-failure-hint" data-testid="blocker-need">
            {tr("features.blocker.need", { text: d.need })}
          </p>
          <div className="blocker-actions">
            {props.onSend
              ? d.options?.map((option) => (
                  <button
                    key={option}
                    type="button"
                    className="model-failure-retry"
                    data-testid="blocker-option"
                    disabled={props.disabled}
                    onClick={() => props.onSend?.(option)}
                  >
                    {option}
                  </button>
                ))
              : null}
            <button
              type="button"
              className="model-failure-retry"
              data-testid="blocker-reply"
              onClick={() => {
                requestAnimationFrame(() => {
                  const input = document.querySelector<HTMLTextAreaElement>(
                    '[data-testid="prompt-input"]',
                  );
                  input?.focus();
                });
                useShellStore.getState().setView("thread");
              }}
            >
              {tr("features.blocker.reply")}
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
