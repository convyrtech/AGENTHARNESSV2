/**
 * Empty chat, casual mode: four example tasks, one per line. A click puts the text in the
 * composer and focuses it; nothing is sent. The chat's first message replaces the empty state.
 */
import { t, type Locale, type MessageKey } from "../lib/i18n.ts";
import { useCasualPrefs } from "../hooks/useCasualPrefs.ts";

const EXAMPLES: readonly MessageKey[] = [
  "empty.example.site",
  "empty.example.sheet",
  "empty.example.bot",
  "empty.example.explore",
];

export function ExampleTaskChips(props: { locale: Locale; onPick: (text: string) => void }) {
  const { developerMode } = useCasualPrefs();
  if (developerMode) return null;
  return (
    <div className="example-chips" data-testid="example-chips">
      {EXAMPLES.map((key) => {
        const text = t(props.locale, key);
        return (
          <button
            key={key}
            type="button"
            className="example-chip"
            onClick={() => props.onPick(text)}
          >
            {text}
          </button>
        );
      })}
    </div>
  );
}
