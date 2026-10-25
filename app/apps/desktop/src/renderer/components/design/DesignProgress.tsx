/**
 * «Дизайн» while a turn runs: one live line for the step («Проверяю страницу на телефоне и
 * компьютере · 12 мин»), the step number and roughly how long it has left, «Думаю над шагом…»
 * after a long silence, «Остановить», and the raw tool calls only under «Подробности».
 */
import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { type DesignView, elapsedMinutes, harnessNow, stepOf } from "../../lib/design-state.ts";
import { doingKey, isSilent, remaining, remainingKey } from "../../lib/design-progress.ts";
import type { MessageKey } from "../../lib/i18n.ts";
import { cn } from "../../lib/utils.ts";
import { LineLoader } from "../motion/LineLoader.tsx";
import { RollText } from "../motion/RollText.tsx";

type Tr = (key: MessageKey, vars?: Record<string, string>) => string;

export function DesignProgress(props: {
  view: DesignView;
  /** Wall clock, ticking while the turn runs. */
  now: number;
  tr: Tr;
  stopping: boolean;
  onStop: () => void;
}) {
  const { view, tr } = props;
  const [open, setOpen] = useState(false);
  const stage = view.stage;
  const step = stage ? stepOf(stage.gate) : undefined;
  const now = harnessNow(view, props.now);
  const minutes = elapsedMinutes(stage, now);
  const left = step && stage ? remaining(step.index, now - stage.stepSince) : undefined;
  const silent = isSilent(view.lastEventAt, props.now);
  const doing = props.stopping
    ? tr("design.progress.stopping")
    : silent
      ? tr("design.progress.silent")
      : view.doing || tr(doingKey(stage?.gate));
  const meta = [
    step ? tr("design.progress.step", { n: String(step.index), total: String(step.total) }) : "",
    left && !props.stopping
      ? tr(remainingKey(left), left.kind === "minutes" ? { n: String(left.n) } : {})
      : "",
  ].filter(Boolean);
  return (
    <div className="mx-auto w-full max-w-3xl px-6 pb-2" data-testid="design-progress">
      <div className="flex items-center gap-2 text-sm">
        <LineLoader className="design-progress-loader" />
        <span className="min-w-0 truncate" data-testid="design-progress-step">
          {doing}
        </span>
        {minutes > 0 ? (
          <RollText
            className="shrink-0 text-muted-foreground"
            testId="design-progress-time"
            text={`· ${tr("design.progress.minutes", { n: String(minutes) })}`}
          />
        ) : null}
        <span className="flex-1" />
        <button
          type="button"
          className="design-progress-stop"
          data-testid="design-stop-step"
          disabled={props.stopping}
          onClick={props.onStop}
        >
          {tr("design.stop.button")}
        </button>
      </div>
      <div className="mt-0.5 flex items-center gap-2 pl-9 text-xs text-muted-foreground">
        <RollText testId="design-progress-meta" text={meta.join(" · ")} />
        {view.ticker.length ? (
          <button
            type="button"
            className="design-progress-toggle"
            aria-expanded={open}
            data-testid="design-progress-details"
            onClick={() => setOpen((value) => !value)}
          >
            <ChevronRight
              className={cn("size-3 transition-transform", open && "rotate-90")}
              strokeWidth={2}
            />
            {tr("design.progress.details")}
          </button>
        ) : null}
      </div>
      {open ? (
        <ol
          className="mt-1 ml-9 flex flex-col gap-0.5 font-mono text-xs text-muted-foreground/80"
          data-testid="design-ticker"
        >
          {view.ticker.map((line, index) => (
            <li key={index} className="truncate">
              {line}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
