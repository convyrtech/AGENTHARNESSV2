/**
 * General → «Для разработчиков» and the ruble rate. Kept out of SettingsPage.tsx, which is
 * at its line budget.
 */
import { useEffect, useState } from "react";
import type { MessageKey } from "../../lib/i18n.ts";
import { normalizeRubPerUsd, saveCasualPrefs } from "../../lib/casual-prefs.ts";
import { useCasualPrefs } from "../../hooks/useCasualPrefs.ts";
import {
  SettingsInput,
  SettingsRow,
  SettingsSectionBlock,
  SettingsToggle,
} from "./SettingsPrimitives.tsx";

export function CasualPrefsBlock(props: { tr: (key: MessageKey) => string }) {
  const { tr } = props;
  const prefs = useCasualPrefs();
  const [rateDraft, setRateDraft] = useState(String(prefs.rubPerUsd));

  useEffect(() => {
    setRateDraft(String(prefs.rubPerUsd));
  }, [prefs.rubPerUsd]);

  function commitRate() {
    const next = normalizeRubPerUsd(rateDraft);
    saveCasualPrefs({ rubPerUsd: next });
    setRateDraft(String(next));
  }

  return (
    <SettingsSectionBlock label={tr("casual.section")} testId="settings-casual">
      <SettingsRow
        title={tr("casual.rubPerUsd")}
        control={
          <SettingsInput
            className="w-24 text-right"
            inputMode="decimal"
            value={rateDraft}
            data-testid="settings-rub-per-usd"
            aria-label={tr("casual.rubPerUsd")}
            onChange={(event) => setRateDraft(event.target.value)}
            onBlur={commitRate}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitRate();
            }}
          />
        }
      />
      <SettingsRow
        title={tr("casual.developerMode")}
        description={tr("casual.developerModeHint")}
        control={
          <SettingsToggle
            checked={prefs.developerMode}
            onChange={(on) => saveCasualPrefs({ developerMode: on })}
            testId="settings-developer-mode"
            aria-label={tr("casual.developerMode")}
          />
        }
        last
      />
    </SettingsSectionBlock>
  );
}
