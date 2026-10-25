/**
 * A text whose digits roll into place when they change (timers, ₽, «осталось ~N мин»). The
 * text content stays exactly the text, so tests and screen readers read it as is; the first
 * render does not roll, and reduced motion turns the roll off in blueprint.css.
 */
import { useEffect, useState } from "react";
import { rollPieces } from "../../lib/roll-text.ts";
import { cn } from "../../lib/utils.ts";

export function RollText(props: { text: string; className?: string; testId?: string }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => setArmed(true), []);
  return (
    <span className={cn("roll-text", props.className)} data-testid={props.testId}>
      {rollPieces(props.text).map((piece) =>
        piece.digit ? (
          <span key={piece.key} className={cn("roll-digit", armed && "roll-digit-in")}>
            {piece.text}
          </span>
        ) : (
          <span key={piece.key}>{piece.text}</span>
        ),
      )}
    </span>
  );
}
