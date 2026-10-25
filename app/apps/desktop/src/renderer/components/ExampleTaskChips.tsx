/**
 * Empty chat, casual mode: three example tasks. A click puts the text in the composer and
 * focuses it; nothing is sent.
 */
import { t, type Locale, type MessageKey } from "../lib/i18n.ts";
import { useCasualPrefs } from "../hooks/useCasualPrefs.ts";

const EXAMPLES: readonly MessageKey[] = [
  "empty.example.site",
  "empty.example.explore",
  "empty.example.fix",
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
