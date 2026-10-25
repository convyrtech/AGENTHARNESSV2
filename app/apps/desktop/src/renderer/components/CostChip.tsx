/**
 * «ход 1,20 ₽ · чат 8,40 ₽» next to the composer's model control. Reads the session cost
 * from the shell snapshot; the turn share comes from lib/rub-cost.ts.
 */
import { useEffect, useState } from "react";
import { t, type Locale } from "../lib/i18n.ts";
import { formatRub, INITIAL_TURN_COST, nextTurnCost, usdToRub } from "../lib/rub-cost.ts";
import { useCasualPrefs } from "../hooks/useCasualPrefs.ts";
import { useShellStore } from "../store/shell-store.ts";

/**
 * The turn tracker outlives the chip: the composer unmounts on a trip to Settings, and a
 * component-local tracker came back empty («ход» reset). One app, one foreground session.
 */
let tracker = INITIAL_TURN_COST;

export function CostChip(props: { locale: Locale }) {
  const snapshot = useShellStore((s) => s.snapshot);
  const running = useShellStore((s) => s.running);
  const { rubPerUsd } = useCasualPrefs();
  const [turnUsd, setTurnUsd] = useState<number | undefined>(() => tracker.turnUsd);
  const sessionKey = snapshot?.sessionFile ?? snapshot?.sessionId;
  const sessionUsd = snapshot?.usage?.cost;

  useEffect(() => {
    tracker = nextTurnCost(tracker, { sessionKey, running, sessionUsd });
    setTurnUsd(tracker.turnUsd);
  }, [sessionKey, running, sessionUsd]);

  if (typeof sessionUsd !== "number" || !Number.isFinite(sessionUsd)) return null;
  // Zero means nothing spent yet, or a model without prices: no tag rather than «0,00 ₽».
  if (sessionUsd <= 0) return null;
  const rub = (usd: number) => formatRub(usdToRub(usd, rubPerUsd), props.locale);
  const sessionLabel = t(props.locale, "cost.session", { amount: rub(sessionUsd) });
  // pi adds a reply's cost when the reply ends, so a running turn grows in steps. A turn that
  // has cost nothing (not replied yet, or failed before any reply) shows no «ход 0,00 ₽».
  const turnLabel =
    turnUsd !== undefined && turnUsd > 0
      ? t(props.locale, "cost.turn", { amount: rub(turnUsd) })
      : undefined;

  return (
    <span
      className="cost-chip"
      data-testid="cost-chip"
      title={turnLabel ? `${turnLabel} · ${sessionLabel}` : sessionLabel}
    >
      {turnLabel ? (
        <>
          <span data-testid="cost-turn">{turnLabel}</span>
          <span aria-hidden className="cost-chip-sep">
            ·
          </span>
        </>
      ) : null}
      <span data-testid="cost-session">{sessionLabel}</span>
    </span>
  );
}
