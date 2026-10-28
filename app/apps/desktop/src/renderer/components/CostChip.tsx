/**
 * «ход 1,20 ₽ · чат 8,40 ₽» next to the composer's model control. Reads the session cost
 * from the shell snapshot; the turn share comes from lib/rub-cost.ts.
 */
import { useEffect, useState } from "react";
import { t, type Locale } from "../lib/i18n.ts";
import { formatRub, INITIAL_TURN_COST, nextTurnCost } from "../lib/rub-cost.ts";
import { useShellStore } from "../store/shell-store.ts";
import { RollText } from "./motion/RollText.tsx";

/**
 * The turn tracker outlives the chip: the composer unmounts on a trip to Settings, and a
 * component-local tracker came back empty («ход» reset). One app, one foreground session.
 */
let tracker = INITIAL_TURN_COST;

export function CostChip(props: { locale: Locale }) {
  const snapshot = useShellStore((s) => s.snapshot);
  const running = useShellStore((s) => s.running);
  const [turnRub, setTurnUsd] = useState<number | undefined>(() => tracker.turnRub);
  const sessionKey = snapshot?.sessionFile ?? snapshot?.sessionId;
  const sessionRub = snapshot?.usage?.cost;

  useEffect(() => {
    tracker = nextTurnCost(tracker, { sessionKey, running, sessionRub });
    setTurnUsd(tracker.turnRub);
  }, [sessionKey, running, sessionRub]);

  if (typeof sessionRub !== "number" || !Number.isFinite(sessionRub)) return null;
  // Zero means nothing spent yet, or a model without prices: no tag rather than «0,00 ₽».
  if (sessionRub <= 0) return null;
  // models.json prices for the PRSLOY provider are already retail ₽ per 1M (#52).
  const rub = (amount: number) => formatRub(amount, props.locale);
  const sessionLabel = t(props.locale, "cost.session", { amount: rub(sessionRub) });
  // pi adds a reply's cost when the reply ends, so a running turn grows in steps. A turn that
  // has cost nothing (not replied yet, or failed before any reply) shows no «ход 0,00 ₽».
  const turnLabel =
    turnRub !== undefined && turnRub > 0
      ? t(props.locale, "cost.turn", { amount: rub(turnRub) })
      : undefined;

  return (
    <span
      className="cost-chip"
      data-testid="cost-chip"
      title={turnLabel ? `${turnLabel} · ${sessionLabel}` : sessionLabel}
    >
      {turnLabel ? (
        <span className="cost-chip-turn">
          <RollText testId="cost-turn" text={turnLabel} />
          <span aria-hidden className="cost-chip-sep">
            ·
          </span>
        </span>
      ) : null}
      <RollText testId="cost-session" text={sessionLabel} />
    </span>
  );
}
