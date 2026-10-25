/**
 * «ход 1,20 ₽ · чат 8,40 ₽» next to the composer's model control. Reads the session cost
 * from the shell snapshot; the turn share comes from lib/rub-cost.ts.
 */
import { useEffect, useRef, useState } from "react";
import { t, type Locale } from "../lib/i18n.ts";
import { formatRub, INITIAL_TURN_COST, nextTurnCost, usdToRub } from "../lib/rub-cost.ts";
import { useCasualPrefs } from "../hooks/useCasualPrefs.ts";
import { useShellStore } from "../store/shell-store.ts";

export function CostChip(props: { locale: Locale }) {
  const snapshot = useShellStore((s) => s.snapshot);
  const running = useShellStore((s) => s.running);
  const { rubPerUsd } = useCasualPrefs();
  const tracker = useRef(INITIAL_TURN_COST);
  const [turnUsd, setTurnUsd] = useState<number | undefined>(undefined);
  const sessionKey = snapshot?.sessionFile ?? snapshot?.sessionId;
  const sessionUsd = snapshot?.usage?.cost;

  useEffect(() => {
    tracker.current = nextTurnCost(tracker.current, { sessionKey, running, sessionUsd });
    setTurnUsd(tracker.current.turnUsd);
  }, [sessionKey, running, sessionUsd]);

  if (typeof sessionUsd !== "number" || !Number.isFinite(sessionUsd)) return null;
  // Nothing spent and no turn yet: an empty chat needs no price tag.
  if (sessionUsd === 0 && turnUsd === undefined) return null;
  const rub = (usd: number) => formatRub(usdToRub(usd, rubPerUsd), props.locale);
  const sessionLabel = t(props.locale, "cost.session", { amount: rub(sessionUsd) });
  const turnLabel =
    turnUsd !== undefined ? t(props.locale, "cost.turn", { amount: rub(turnUsd) }) : undefined;

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
