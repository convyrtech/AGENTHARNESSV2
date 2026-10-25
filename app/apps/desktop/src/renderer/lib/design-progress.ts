/**
 * The «Дизайн» progress line: what the agent is doing in words, how long the step has run,
 * roughly how long it has left, and a calm line when nothing has happened for a while.
 */
import type { MessageKey } from "./i18n.ts";

/**
 * Typical length of one turn's work in each of the eight steps, minutes: the longest single
 * turn per step in the conductor's real run (e2e/design/fixtures/ab-run-2026-10-25, 8 turns,
 * 2 h 56 min, DeepSeek/Kimi with an Opus judge), from each `stage` event to the next one or
 * to the end of the turn. Step 7 (build and checks) took 79 min and 321 tool calls.
 */
export const STEP_TYPICAL_MINUTES: readonly number[] = [5, 3, 6, 16, 4, 17, 79, 21];

/** What the agent does at each gate, said as it would («Проверяю страницу…»). */
const GATE_DOING: Readonly<Record<string, MessageKey>> = {
  "0": "design.doing.start",
  "0a": "design.doing.start",
  "1": "design.doing.start",
  "2": "design.doing.brand",
  "2a": "design.doing.meaning",
  "3": "design.doing.refs",
  "4": "design.doing.motion",
  "5": "design.doing.prototypes",
  "6": "design.doing.build",
  "7": "design.doing.check",
  "8": "design.doing.publish",
};

export function doingKey(gate: string | undefined): MessageKey {
  return (gate && GATE_DOING[gate]) || "design.progress.working";
}

/** No event for this long: the line says the agent is thinking instead of looking frozen. */
export const SILENCE_MS = 3 * 60_000;

export type Remaining =
  | { kind: "minutes"; n: number }
  | { kind: "aboutOne" }
  /** Past the typical length: no made-up number. */
  | { kind: "over" };

/** Time left in a step that has run `elapsedMs`, from the typical lengths above. */
export function remaining(stepIndex: number, elapsedMs: number): Remaining | undefined {
  const typical = STEP_TYPICAL_MINUTES[stepIndex - 1];
  if (typical === undefined) return undefined;
  const left = typical - elapsedMs / 60_000;
  if (left <= 0) return { kind: "over" };
  if (left < 1.5) return { kind: "aboutOne" };
  return { kind: "minutes", n: Math.round(left) };
}

export function remainingKey(left: Remaining): MessageKey {
  return left.kind === "minutes"
    ? "design.progress.left"
    : left.kind === "aboutOne"
      ? "design.progress.leftOne"
      : "design.progress.over";
}

export function isSilent(lastEventAt: number | undefined, now: number): boolean {
  return lastEventAt !== undefined && now - lastEventAt > SILENCE_MS;
}

/** A turn this long asks before «Остановить»: it would throw away real work in progress. */
export const CONFIRM_STOP_AFTER_MS = 2 * 60_000;
