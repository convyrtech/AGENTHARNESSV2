/**
 * «остаток 3 776 ₽» next to the ₽ cost of the chat (#56). Shown in developer mode like CostChip;
 * when the money runs out the chip appears even in casual mode, because that is a warning worth
 * seeing before a task, not an error in the middle of one. The hover line adds the chat's own
 * pace: how many turns this balance still buys.
 */
import { useEffect, useState } from "react";
import { t, type Locale } from "../lib/i18n.ts";
import { formatRub } from "../lib/rub-cost.ts";
import {
  averageTurnRub,
  balanceAgeMinutes,
  balanceIsLow,
  INITIAL_TURN_WATCH,
  usePrsloyBalance,
  nextTurnWatch,
  turnsLeft,
  type TurnWatch,
} from "../lib/prsloy-balance.ts";
import { useCasualPrefs } from "../hooks/useCasualPrefs.ts";
import { useShellStore } from "../store/shell-store.ts";

/** Outlives the chip, like CostChip's tracker: a trip to Settings must not reset the pace. */
let watch: TurnWatch = INITIAL_TURN_WATCH;

export function BalanceChip(props: { locale: Locale }) {
  const { developerMode } = useCasualPrefs();
  // Main asks the gateway hourly; this only asks main, so the number never sits in two places.
  const { balance } = usePrsloyBalance();
  const snapshot = useShellStore((s) => s.snapshot);
  const running = useShellStore((s) => s.running);
  const [avgTurnRub, setAvgTurnRub] = useState<number | undefined>(() => averageTurnRub(watch));
  const sessionKey = snapshot?.sessionFile ?? snapshot?.sessionId;
  const sessionRub = snapshot?.usage?.cost;

  useEffect(() => {
    const next = nextTurnWatch(watch, { sessionKey, running, sessionRub });
    if (next !== watch) {
      watch = next;
      setAvgTurnRub(averageTurnRub(next));
    }
  }, [sessionKey, running, sessionRub]);

  // Developer mode shows the balance always; anyone else sees it only when it runs low (#56).
  if (!balance || (!developerMode && !balanceIsLow(balance))) return null;
  const amount = formatRub(balance.remainingRub, props.locale);
  const low = balanceIsLow(balance);
  const label = t(props.locale, "prsloy.balance.chip", { amount });
  const left = turnsLeft(balance, avgTurnRub ?? 0);
  const details = [
    left !== undefined ? t(props.locale, "prsloy.balance.turns", { count: String(left) }) : "",
    t(props.locale, "prsloy.balance.updated", {
      minutes: String(balanceAgeMinutes(balance.fetchedAt)),
    }),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <span
      className={low ? "cost-chip prsloy-balance-low" : "cost-chip"}
      data-testid="balance-chip"
      data-low={low ? "1" : undefined}
      title={`${label} — ${details}`}
    >
      {label}
    </span>
  );
}
