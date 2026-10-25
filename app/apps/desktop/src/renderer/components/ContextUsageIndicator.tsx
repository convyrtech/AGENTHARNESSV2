/**
 * Context-window ring on the composer (moved out of Composer.tsx, which is at its budget).
 */
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

function formatContext(percent: number | undefined, tokens: number | undefined): string {
  if (percent != null && Number.isFinite(percent)) return `${Math.round(percent)}%`;
  if (tokens != null && Number.isFinite(tokens) && tokens > 0) {
    if (tokens >= 1000) return `${(tokens / 1000).toFixed(tokens >= 10_000 ? 0 : 1)}k`;
    return `${tokens}`;
  }
  // No live usage yet — show empty capacity, never a dash.
  return "0%";
}

export function ContextUsageIndicator(props: {
  label: string;
  percent: number | undefined;
  tokens: number | undefined;
}) {
  const rawPercent = props.percent;
  const hasPercent = rawPercent != null && Number.isFinite(rawPercent);
  const value = hasPercent ? Math.min(100, Math.max(0, Math.round(rawPercent))) : 0;
  const detail = formatContext(props.percent, props.tokens);
  const accessibleLabel = `${props.label}: ${detail}`;

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground"
            data-testid="usage-chip"
            data-context-percent={value}
            role="meter"
            aria-label={accessibleLabel}
            aria-valuemin={0}
            aria-valuemax={100}
            {...(hasPercent ? { "aria-valuenow": value } : {})}
          >
            <svg className="size-4" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <circle
                cx="10"
                cy="10"
                r="7"
                stroke="currentColor"
                strokeWidth="2.25"
                opacity="0.2"
              />
              {value > 0 ? (
                <circle
                  cx="10"
                  cy="10"
                  r="7"
                  pathLength="100"
                  stroke="currentColor"
                  strokeWidth="2.25"
                  strokeLinecap="round"
                  strokeDasharray="100"
                  strokeDashoffset={100 - value}
                  transform="rotate(-90 10 10)"
                />
              ) : null}
            </svg>
            <span className="sr-only">{detail}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">{accessibleLabel}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
