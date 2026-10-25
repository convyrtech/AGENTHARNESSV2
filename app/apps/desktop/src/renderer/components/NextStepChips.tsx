/**
 * «Что дальше» under the last finished turn: 2–3 next requests (`lib/next-steps.ts`). Like
 * the empty chat's examples, a click puts the text in the composer and focuses it; nothing
 * is sent. Hidden while the owner is typing, as in Dyad's ChatInput.
 */
import { t, type Locale } from "../lib/i18n.ts";
import { useShellStore } from "../store/shell-store.ts";
import "./code-preview-features.css";

export function NextStepChips(props: { locale: Locale; steps: readonly string[] }) {
  const draft = useShellStore((s) => s.prompt);
  if (props.steps.length === 0 || draft.trim()) return null;
  return (
    <div className="next-steps" data-testid="next-steps">
      <span className="next-steps-title">{t(props.locale, "features.next.title")}</span>
      {props.steps.map((step) => (
        <button
          key={step}
          type="button"
          className="example-chip next-step"
          data-testid="next-step"
          onClick={() => {
            useShellStore.getState().setPrompt(step);
            requestAnimationFrame(() => {
              const input = document.querySelector<HTMLTextAreaElement>(
                '[data-testid="prompt-input"]',
              );
              input?.focus();
              input?.setSelectionRange(input.value.length, input.value.length);
            });
          }}
        >
          {step}
        </button>
      ))}
    </div>
  );
}
