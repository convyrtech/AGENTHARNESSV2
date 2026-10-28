/**
 * Cost in rubles: per turn and per session.
 *
 * pi reports the PRSLOY session cost in rubles (`snapshot.usage.cost`) and nothing per
 * message, so a turn's cost is the growth of the session cost while that turn runs. The
 * tracker is a pure reducer over (session, running, cost) samples taken from snapshots.
 */

import { localeTag, type Locale } from "./i18n.ts";

export type TurnCostState = {
  sessionKey: string | undefined;
  /** Session cost (USD) when the current or last turn started. */
  turnStartRub: number | undefined;
  /** Cost (USD) of the current turn while it runs, or of the last finished turn. */
  turnRub: number | undefined;
  running: boolean;
};

export type CostSample = {
  sessionKey: string | undefined;
  running: boolean;
  /** Session cost in USD, when the host reported one. */
  sessionRub: number | undefined;
};

export const INITIAL_TURN_COST: TurnCostState = {
  sessionKey: undefined,
  turnStartRub: undefined,
  turnRub: undefined,
  running: false,
};

export function nextTurnCost(prev: TurnCostState, sample: CostSample): TurnCostState {
  const cost =
    typeof sample.sessionRub === "number" && Number.isFinite(sample.sessionRub)
      ? sample.sessionRub
      : undefined;
  if (sample.sessionKey !== prev.sessionKey) {
    // A different session: nothing known about its turns yet, except one starting now.
    return {
      sessionKey: sample.sessionKey,
      turnStartRub: sample.running ? cost : undefined,
      turnRub: sample.running && cost !== undefined ? 0 : undefined,
      running: sample.running,
    };
  }
  if (sample.running && !prev.running) {
    return {
      ...prev,
      running: true,
      turnStartRub: cost,
      turnRub: cost !== undefined ? 0 : undefined,
    };
  }
  if (cost === undefined || prev.turnStartRub === undefined) {
    return { ...prev, running: sample.running };
  }
  // Cost only grows within a session; a drop means the host restarted the count.
  const turnRub = cost >= prev.turnStartRub ? cost - prev.turnStartRub : prev.turnRub;
  return { ...prev, running: sample.running, turnRub };
}

/** «1,23 ₽» — kopecks under 100 ₽, whole rubles above, «<0,01 ₽» for a non-zero dust amount. */
export function formatRub(rub: number, locale: Locale): string {
  const value = Math.max(0, rub);
  if (value > 0 && value < 0.01) {
    return `<${formatRub(0.01, locale)}`;
  }
  const digits = value >= 100 ? 0 : 2;
  return new Intl.NumberFormat(localeTag(locale), {
    style: "currency",
    currency: "RUB",
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}
