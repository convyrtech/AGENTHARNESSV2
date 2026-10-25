/**
 * The turn's outcome from the harness's facts (#10): «Проверки прошли · Страница открылась без
 * ошибок», or «Проверки не прошли» as a card above the model's reply. Written by code, not by the
 * model; see lib/turn-status.ts.
 */
import { CircleAlert, CircleCheck, CircleX, Info } from "lucide-react";
import { t, type Locale } from "../lib/i18n.ts";
import { turnFactKey, type TurnStatus } from "../lib/turn-status.ts";

const ICON = { fail: CircleX, warn: CircleAlert, ok: CircleCheck, neutral: Info } as const;

export function TurnStatusLine(props: { locale: Locale; status: TurnStatus }) {
  const { status } = props;
  const Icon = ICON[status.tone];
  return (
    <div
      className="turn-status"
      role="status"
      aria-label={t(props.locale, "turnStatus.label")}
      data-testid="turn-status"
      data-tone={status.tone}
      data-facts={status.facts.join(" ")}
    >
      <Icon className="turn-status-icon size-4 shrink-0" strokeWidth={1.75} aria-hidden />
      <div className="min-w-0">
        <p className="turn-status-facts">
          {status.facts.map((fact) => t(props.locale, turnFactKey(fact))).join(" · ")}
        </p>
        {status.files.length ? (
          <p className="turn-status-files">
            {t(props.locale, "turnStatus.files", { files: status.files.join(", ") })}
          </p>
        ) : null}
        {status.claims.length ? (
          <ul className="turn-status-files turn-status-page" data-testid="turn-status-claims">
            {status.claims.map((claim) => (
              <li key={claim.quote}>
                {claim.why
                  ? t(props.locale, "turnStatus.claim", { quote: claim.quote, why: claim.why })
                  : t(props.locale, "turnStatus.claimQuote", { quote: claim.quote })}
              </li>
            ))}
          </ul>
        ) : null}
        {status.page.length ? (
          <ul className="turn-status-files turn-status-page" data-testid="turn-status-page">
            {status.page.map((finding) => (
              <li key={finding}>{finding}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
