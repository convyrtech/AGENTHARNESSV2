/**
 * A harness card in the chat (second-model review, budget stop, failing project check,
 * confused model): the harness's own plain line and an icon, no technical title. The review
 * opens its remarks, the failing check its output under «Подробности», and the confused model
 * offers the «Повторить» its text asks for.
 */
import { useState } from "react";
import { ChevronRight, Info, ListChecks, RotateCcw, ShieldCheck } from "lucide-react";
import {
  harnessBodyKey,
  harnessOffersRetry,
  harnessTitleKey,
  harnessUsesOwnText,
  reviewRemarks,
  stopGateOutput,
  type HarnessCardKind,
} from "../lib/harness-card.ts";
import { t, type Locale } from "../lib/i18n.ts";
import { cn } from "../lib/utils.ts";

export function HarnessCard(props: {
  locale: Locale;
  kind: HarnessCardKind;
  text: string;
  details?: unknown;
  onRetry?: (() => void) | undefined;
  disabled?: boolean | undefined;
}) {
  const [open, setOpen] = useState(false);
  const ownText = harnessUsesOwnText(props.kind) ? props.text.trim() : "";
  // The generic title and line only stand in for a card that came without its text.
  const title = ownText || t(props.locale, harnessTitleKey(props.kind));
  const bodyKey = ownText ? undefined : harnessBodyKey(props.kind);
  const retry = harnessOffersRetry(props.kind) ? props.onRetry : undefined;
  const remarks = props.kind === "review" ? reviewRemarks(props.details) : [];
  const raw =
    props.kind === "stopGate"
      ? (stopGateOutput(props.details) ?? "")
      : props.kind === "note"
        ? props.text.trim()
        : "";
  const Icon = props.kind === "review" ? (remarks.length ? ListChecks : ShieldCheck) : Info;
  const toggleLabel = remarks.length
    ? t(props.locale, "harness.review.remarks", { count: String(remarks.length) })
    : t(props.locale, "system.details");
  const foldable = remarks.length > 0 || raw !== "";
  return (
    <div
      className="model-failure harness-card"
      data-kind="system"
      data-harness={props.kind}
      data-testid="harness-card"
    >
      <div className="model-failure-head">
        <Icon className="size-4 shrink-0" strokeWidth={1.75} />
        <span className="model-failure-title">{title}</span>
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
      {foldable ? (
        <>
          <button
            type="button"
            className="model-failure-toggle"
            aria-expanded={open}
            data-testid="harness-card-toggle"
            onClick={() => setOpen((value) => !value)}
          >
            <ChevronRight
              className={cn("size-3.5 transition-transform", open && "rotate-90")}
              strokeWidth={2}
            />
            {toggleLabel}
          </button>
          {open && remarks.length ? (
            <ol className="harness-card-remarks" data-testid="harness-card-remarks">
              {remarks.map((remark, index) => (
                <li key={index}>
                  {remark.where ? <code>{remark.where}</code> : null}
                  {remark.where ? " — " : null}
                  {remark.problem}
                </li>
              ))}
            </ol>
          ) : null}
          {open && !remarks.length ? <pre className="model-failure-detail">{raw}</pre> : null}
        </>
      ) : null}
    </div>
  );
}
