/**
 * Full-window cold-start gate: the launch splash (a line draws, the PRSLOY wordmark rises out
 * of it, under 1.2 s) and then live pi / host bootstrap status with the waiting line.
 * Blocks interaction until App marks bootstrap ready; a boot faster than the splash lets
 * clicks through at once and keeps the splash on screen until it has played.
 */
import { useEffect, useState } from "react";
import { LineLoader } from "./motion/LineLoader.tsx";
import { cn } from "../lib/utils.ts";

/** How long the splash takes to play (blueprint.css: line 0.35 s, wordmark 0.25 s + 0.45 s). */
const SPLASH_MS = 700;

export function BootstrapOverlay(props: {
  ready: boolean;
  status: string;
  /** Optional secondary line (e.g. npm install tail). */
  detail?: string;
  error?: string;
  className?: string;
}) {
  const [shownAt] = useState(() => performance.now());
  const [playing, setPlaying] = useState(!props.ready);
  useEffect(() => {
    if (!props.ready) return setPlaying(true);
    const left = SPLASH_MS - (performance.now() - shownAt);
    if (left <= 0 || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      return setPlaying(false);
    }
    const timer = window.setTimeout(() => setPlaying(false), left);
    return () => window.clearTimeout(timer);
  }, [props.ready, shownAt]);
  if (props.ready && !playing) return null;
  return (
    <div
      className={cn("bootstrap-overlay", props.className)}
      data-testid="bootstrap-overlay"
      data-ready={props.ready ? "true" : "false"}
      role="status"
      aria-live="polite"
      aria-busy={!props.ready}
    >
      <div className="bootstrap-overlay-inner">
        <div className="brand-splash" data-testid="brand-splash">
          <div className="brand-splash-word">
            <span className="bootstrap-brand brand-wordmark">PRSLOY</span>
          </div>
          <svg
            className="brand-splash-line"
            viewBox="0 0 160 2"
            preserveAspectRatio="none"
            aria-hidden
          >
            <path d="M0 1 H160" pathLength={1} />
          </svg>
        </div>
        {props.error ? null : <LineLoader className="bootstrap-loader" />}
        <div className="bootstrap-status" data-testid="bootstrap-status">
          {props.status}
        </div>
        {props.detail ? (
          <div className="bootstrap-detail" data-testid="bootstrap-detail">
            {props.detail}
          </div>
        ) : null}
        {props.error ? (
          <div className="bootstrap-error" data-testid="bootstrap-error" role="alert">
            {props.error}
          </div>
        ) : null}
      </div>
    </div>
  );
}
