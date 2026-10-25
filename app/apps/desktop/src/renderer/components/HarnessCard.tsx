/**
 * A harness card in the chat (budget stop, failing project check, confused model): a plain
 * title and one line, «Повторить» where the text asks for it, the harness's own text folded
 * away under «Подробности».
 */
import { useState } from "react";
import { ChevronRight, Info, RotateCcw } from "lucide-react";
import {
  harnessBodyKey,
  harnessOffersRetry,
  harnessTitleKey,
  type HarnessCardKind,
} from "../lib/harness-card.ts";
import { t, type Locale } from "../lib/i18n.ts";
import { cn } from "../lib/utils.ts";

export function HarnessCard(props: {
  locale: Locale;
  kind: HarnessCardKind;
  text: string;
  onRetry?: (() => void) | undefined;
  disabled?: boolean | undefined;
}) {
  const [open, setOpen] = useState(false);
  const bodyKey = harnessBodyKey(props.kind);
  const retry = harnessOffersRetry(props.kind) ? props.onRetry : undefined;
  // «Модель сбилась» is the whole message already; other cards keep the harness's record.
  const details = props.kind === "toolLeak" ? "" : props.text.trim();
  return (
    <div
      className="model-failure harness-card"
      data-kind="system"
      data-harness={props.kind}
      data-testid="harness-card"
    >
      <div className="model-failure-head">
        <Info className="size-4 shrink-0" strokeWidth={1.75} />
        <span className="model-failure-title">{t(props.locale, harnessTitleKey(props.kind))}</span>
        {retry ? (
          <button
            type="button"
            className="model-failure-retry"
            data-testid="harness-card-retry"
            disabled={props.disabled}
            onClick={retry}
          >
            <RotateCcw className="size-3.5" strokeWidth={1.75} />
            {t(props.locale, "system.retry.action")}
          </button>
        ) : null}
      </div>
      {bodyKey ? <p className="model-failure-hint">{t(props.locale, bodyKey)}</p> : null}
      {details ? (
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
          {open ? <pre className="model-failure-detail">{details}</pre> : null}
        </>
      ) : null}
    </div>
  );
}
