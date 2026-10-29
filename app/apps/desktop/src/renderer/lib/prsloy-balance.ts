/**
 * Money left on the PRSLOY key, in the renderer (#56).
 *
 * Main reads the gateway's billing routes at startup and hourly; this only asks main for what
 * it already knows — once a minute and whenever the window comes back. The point is a number a
 * person can compare with what the chat has already cost: enough left for another turn, or not.
 *
 * Turn average is measured, not guessed: pi does not report a turn count, so the chip watches
 * the session cost grow and counts the turns it sees finish.
 */
import { useCallback, useEffect, useState } from "react";
import type { PrsloyBalance } from "@zeno/contracts";
import { prsloyBalanceWarnRub } from "../../shared/prsloy-config.ts";

/** A minute: main refreshes hourly, this only carries its answer to the screen. */
export const PRSLOY_BALANCE_POLL_MS = 60_000;

/** Below the warning line, or no money at all. A key the gateway never answered is not low. */
export function balanceIsLow(
  balance: PrsloyBalance | undefined,
  warnRub = prsloyBalanceWarnRub(),
): boolean {
  if (!balance) return false;
  return warnRub > 0 && balance.remainingRub < warnRub;
}

/** Whole turns the chat can still afford at its own pace. Unknown pace: no prediction. */
export function turnsLeft(balance: PrsloyBalance, avgTurnRub: number): number | undefined {
  if (!Number.isFinite(avgTurnRub) || avgTurnRub <= 0) return undefined;
  return Math.floor(balance.remainingRub / avgTurnRub);
}

/** Minutes since main read the number; a big value means the gateway has been silent. */
export function balanceAgeMinutes(fetchedAt: string, now: number = Date.now()): number {
  const at = Date.parse(fetchedAt);
  if (Number.isNaN(at)) return 0;
  return Math.max(0, Math.round((now - at) / 60_000));
}

export type TurnWatch = {
  sessionKey: string | undefined;
  /** Session cost when the current (or last counted) turn started. */
  startRub: number | undefined;
  turns: number;
  totalRub: number;
  running: boolean;
};

export const INITIAL_TURN_WATCH: TurnWatch = {
  sessionKey: undefined,
  startRub: undefined,
  turns: 0,
  totalRub: 0,
  running: false,
};

export type TurnSample = {
  sessionKey: string | undefined;
  running: boolean;
  sessionRub: number | undefined;
};

/** Count finished turns and what they cost: the chat's own pace, measured. */
export function nextTurnWatch(prev: TurnWatch, sample: TurnSample): TurnWatch {
  const cost =
    typeof sample.sessionRub === "number" && Number.isFinite(sample.sessionRub)
      ? sample.sessionRub
      : undefined;
  if (sample.sessionKey !== prev.sessionKey) {
    return {
      sessionKey: sample.sessionKey,
      startRub: cost,
      turns: 0,
      totalRub: 0,
      running: sample.running,
    };
  }
  if (sample.running && !prev.running) return { ...prev, startRub: cost, running: true };
  if (!sample.running && prev.running) {
    // A turn that cost nothing (failed before any reply) does not bend the average.
    const spent = cost !== undefined && prev.startRub !== undefined ? cost - prev.startRub : 0;
    if (spent > 0)
      return {
        ...prev,
        running: false,
        startRub: cost,
        turns: prev.turns + 1,
        totalRub: prev.totalRub + spent,
      };
    return { ...prev, running: false, startRub: cost };
  }
  return prev;
}

export function averageTurnRub(watch: TurnWatch): number | undefined {
  return watch.turns > 0 ? watch.totalRub / watch.turns : undefined;
}

export function usePrsloyBalance(pollMs = PRSLOY_BALANCE_POLL_MS): {
  balance: PrsloyBalance | undefined;
  refresh: () => Promise<void>;
} {
  const [balance, setBalance] = useState<PrsloyBalance | undefined>();

  const refresh = useCallback(async () => {
    try {
      const state = await window.zeno.prsloy.getState();
      setBalance(state.balance);
    } catch {
      // Main is not answering: keep the last number we had.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const pull = () => {
      if (!cancelled) void refresh();
    };
    pull();
    const timer = setInterval(pull, pollMs);
    const onVisible = () => {
      if (document.visibilityState === "visible") pull();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [pollMs, refresh]);

  return { balance, refresh };
}
