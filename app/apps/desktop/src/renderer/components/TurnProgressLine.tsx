/**
 * One quiet line above the composer while a turn runs longer than 15 s: the waiting line,
 * what the agent is doing now, for how long (the digits roll), and «Остановить».
 */
import { useEffect, useMemo, useState } from "react";
import { Square } from "lucide-react";
import { t, type Locale } from "../lib/i18n.ts";
import { formatDurationMs, type TimelineItem } from "../lib/timeline.ts";
import { LineLoader } from "./motion/LineLoader.tsx";
import { RollText } from "./motion/RollText.tsx";
import { currentTurnAction, PROGRESS_LINE_DELAY_MS, turnStartedAt } from "../lib/turn-progress.ts";

export function TurnProgressLine(props: {
  locale: Locale;
  items: readonly TimelineItem[];
  running: boolean;
  onStop: () => void;
}) {
  const [runStart, setRunStart] = useState<number>();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!props.running) {
      setRunStart(undefined);
      return;
    }
    setRunStart(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [props.running]);

  const action = useMemo(() => currentTurnAction(props.items), [props.items]);
  if (!props.running || runStart === undefined) return null;
  const elapsed = now - turnStartedAt(props.items, runStart);
  if (elapsed < PROGRESS_LINE_DELAY_MS) return null;

  return (
    <div className="turn-progress" role="status" aria-live="polite" data-testid="turn-progress">
      <LineLoader className="turn-progress-loader" />
      <span className="turn-progress-action" data-testid="turn-progress-action">
        {t(props.locale, action.key, action.vars)}
      </span>
      {/* Same clock and format as the step header above («1 мин 59 с»), so the two agree. */}
      <RollText className="turn-progress-time" text={formatDurationMs(elapsed, props.locale)} />
      <button
        type="button"
        className="turn-progress-stop"
        data-testid="turn-progress-stop"
        onClick={props.onStop}
      >
        <Square className="size-3" strokeWidth={2} />
        {t(props.locale, "progress.stop")}
      </button>
    </div>
  );
}
