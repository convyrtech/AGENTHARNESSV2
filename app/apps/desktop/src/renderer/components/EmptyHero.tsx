/**
 * The empty «Код» chat: logo, title, the example tasks and the recipes. Moved out of
 * main.tsx (line budget) when the recipes came in.
 */
import { t, type Locale } from "../lib/i18n.ts";
import { ExampleTaskChips } from "./ExampleTaskChips.tsx";
import { FigCaption } from "./FigCaption.tsx";
import { PixLogo } from "./PixLogo.tsx";
import { RecipeCards } from "./RecipeCards.tsx";

export function EmptyHero(props: {
  locale: Locale;
  title: string;
  subtitle?: string | undefined;
  onPickExample: (text: string) => void;
  onStartRecipe: (path: string, prompt: string) => void;
}) {
  return (
    <div
      className="thread-messages empty flex min-h-full flex-1 flex-col items-center justify-center px-4 text-center"
      data-testid="empty-hero"
    >
      <PixLogo className="mb-5 size-12" title={t(props.locale, "app.name")} />
      <FigCaption locale={props.locale} n={1} label={t(props.locale, "fig.code")} />
      <h1 className="font-display m-0 max-w-lg text-[28px] leading-snug font-semibold tracking-[-0.01em] text-[var(--text)]">
        {props.title}
      </h1>
      {props.subtitle ? (
        <p className="mt-3 max-w-md text-[13px] text-[var(--muted-foreground)]">{props.subtitle}</p>
      ) : null}
      <ExampleTaskChips locale={props.locale} onPick={props.onPickExample} />
      <RecipeCards locale={props.locale} onStart={props.onStartRecipe} />
    </div>
  );
}
