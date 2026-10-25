/**
 * The drafting-sheet caption over a screen's heading, as in the owner's reference
 * («FIG. 01 — DRAFT»): small spaced capitals, a figure number per screen, the screen's name.
 */
import { t, type Locale } from "../lib/i18n.ts";

export function FigCaption(props: { locale: Locale; n: number; label: string }) {
  return (
    <p className="fig-caption" data-testid="fig-caption">
      {t(props.locale, "fig.caption", { n: String(props.n).padStart(2, "0"), label: props.label })}
    </p>
  );
}
