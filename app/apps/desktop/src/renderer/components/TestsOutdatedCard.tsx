/**
 * «Старые тесты расходятся с вашей просьбой» (#25): the harness's question instead of a silent test
 * change. The old test files and the conflicting assertion (monospace, folded when long), then the
 * harness's buttons: one with a prompt sends it as the owner's next message, one without only
 * closes the card. After either, the buttons are gone — the answer cannot be sent twice.
 */
import { useState } from "react";
import { FlaskConical } from "lucide-react";
import { t, type Locale } from "../lib/i18n.ts";
import {
  markAnswered,
  parseTestsOutdated,
  quoteIsLong,
  readAnswered,
  testsOutdatedKey,
} from "../lib/tests-outdated-card.ts";

export function TestsOutdatedCard(props: {
  locale: Locale;
  text: string;
  details?: unknown;
  onSend?: ((text: string) => void) | undefined;
  disabled?: boolean | undefined;
}) {
  const tr = (key: Parameters<typeof t>[1], vars?: Record<string, string>) =>
    t(props.locale, key, vars);
  const d = parseTestsOutdated(props.details);
  const key = d ? testsOutdatedKey(d) : "";
  const [answered, setAnswered] = useState<string | undefined>(() =>
    key ? readAnswered(key) : undefined,
  );
  const [open, setOpen] = useState(false);
  const title = props.text.trim() || tr("harness.testsOutdated.title");
  const long = d ? quoteIsLong(d.quote) : false;

  function choose(action: { label: string; prompt?: string }) {
    if (answered) return;
    setAnswered(action.label);
    markAnswered(key, action.label);
    if (action.prompt) props.onSend?.(action.prompt);
  }

  return (
    <div
      className="model-failure harness-card tests-outdated-card"
      data-kind="system"
      data-testid="tests-outdated-card"
      role="group"
      aria-label={title}
    >
      <div className="model-failure-head">
        <FlaskConical className="size-4 shrink-0" strokeWidth={1.75} />
        <span className="model-failure-title">{title}</span>
      </div>
      {d?.files.length ? (
        <p className="model-failure-hint" data-testid="tests-outdated-files">
          {tr("harness.testsOutdated.files", { files: d.files.join(", ") })}
        </p>
      ) : null}
      {d?.quote ? (
        <div className="tests-outdated-quote">
          <pre
            className={long && !open ? "tests-outdated-pre is-folded" : "tests-outdated-pre"}
            data-testid="tests-outdated-quote"
          >
            {d.quote}
          </pre>
          {long ? (
            <button
              type="button"
              className="model-failure-toggle"
              aria-expanded={open}
              data-testid="tests-outdated-quote-toggle"
              onClick={() => setOpen((v) => !v)}
            >
              {tr(open ? "harness.testsOutdated.collapse" : "harness.testsOutdated.expand")}
            </button>
          ) : null}
        </div>
      ) : null}
      {d ? (
        answered ? (
          <p className="model-failure-hint" role="status" data-testid="tests-outdated-answered">
            {tr("harness.testsOutdated.answered", { label: answered })}
          </p>
        ) : (
          <div className="blocker-actions">
            {d.actions.map((action) => (
              <button
                key={action.label}
                type="button"
                className="model-failure-retry"
                data-testid={action.prompt ? "tests-outdated-update" : "tests-outdated-keep"}
                disabled={props.disabled || (action.prompt !== undefined && !props.onSend)}
                onClick={() => choose(action)}
              >
                {action.label}
              </button>
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}
