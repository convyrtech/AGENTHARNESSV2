/**
 * The waiting line from the owner's reference: a line draws itself, turns into a running wave,
 * then fills with blueprint hatching, and starts over. With `value` (0…1) it is a progress bar:
 * the drawn line and the hatching filled up to the value. Only stroke-dashoffset, transform and
 * opacity move (blueprint.css); it runs only while mounted, and reduced motion stills it.
 */
import { useId } from "react";
import { cn } from "../../lib/utils.ts";

const WAVE = `M-24 5 q6 -3.5 12 0${" t12 0".repeat(13)}`;

export function LineLoader(props: {
  /** 0…1 for a known amount; omitted while the length is unknown. */
  value?: number;
  label?: string | undefined;
  className?: string;
  testId?: string;
}) {
  const id = useId().replace(/:/gu, "");
  const known = props.value !== undefined;
  const value = Math.min(1, Math.max(0, props.value ?? 0));
  return (
    <svg
      className={cn("line-loader", props.className)}
      data-mode={known ? "value" : "wait"}
      data-testid={props.testId}
      viewBox="0 0 120 10"
      preserveAspectRatio="none"
      role="progressbar"
      aria-label={props.label}
      aria-valuemin={known ? 0 : undefined}
      aria-valuemax={known ? 100 : undefined}
      aria-valuenow={known ? Math.round(value * 100) : undefined}
    >
      <defs>
        <pattern
          id={`${id}-hatch`}
          width="5"
          height="5"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <line className="line-loader-hatch" x1="0" y1="0" x2="0" y2="5" />
        </pattern>
        <clipPath id={`${id}-clip`}>
          <rect x="0" y="0" width="120" height="10" />
        </clipPath>
      </defs>
      <rect
        className="line-loader-fill"
        x="0"
        y="1"
        width="120"
        height="8"
        fill={`url(#${id}-hatch)`}
        style={known ? { transform: `scaleX(${value})` } : undefined}
      />
      <path className="line-loader-draw" d="M0 5 H120" pathLength={1} />
      {known ? null : (
        <g clipPath={`url(#${id}-clip)`}>
          <path className="line-loader-wave" d={WAVE} />
        </g>
      )}
    </svg>
  );
}
