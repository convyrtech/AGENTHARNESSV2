/**
 * General → «Для разработчиков». Kept out of SettingsPage.tsx, which is at its line budget.
 * The ruble rate lives in «Аккаунт» (AccountSection.tsx).
 */
import type { MessageKey } from "../../lib/i18n.ts";
import { saveCasualPrefs } from "../../lib/casual-prefs.ts";
import { useCasualPrefs } from "../../hooks/useCasualPrefs.ts";
import { SettingsRow, SettingsSectionBlock, SettingsToggle } from "./SettingsPrimitives.tsx";

export function CasualPrefsBlock(props: { tr: (key: MessageKey) => string }) {
  const { tr } = props;
  const prefs = useCasualPrefs();

  return (
    <SettingsSectionBlock label={tr("casual.section")} testId="settings-casual">
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
