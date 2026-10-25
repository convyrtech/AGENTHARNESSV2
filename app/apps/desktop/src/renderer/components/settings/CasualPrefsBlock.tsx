/**
 * General → «Основное»: «Для разработчиков» and «Проверка второй моделью». Kept out of
 * SettingsPage.tsx, which is at its line budget. The ruble rate lives in «Аккаунт».
 */
import { useEffect, useState } from "react";
import type { MessageKey } from "../../lib/i18n.ts";
import { saveCasualPrefs } from "../../lib/casual-prefs.ts";
import { useCasualPrefs } from "../../hooks/useCasualPrefs.ts";
import { SettingsRow, SettingsSectionBlock, SettingsToggle } from "./SettingsPrimitives.tsx";

export function CasualPrefsBlock(props: { tr: (key: MessageKey) => string }) {
  const { tr } = props;
  const prefs = useCasualPrefs();
  // The harness reads the file on every turn; undefined until main answers.
  const [secondOpinion, setSecondOpinion] = useState<boolean | undefined>();
  useEffect(() => {
    let alive = true;
    void Promise.resolve(window.zeno.harnessFlags?.get())
      .then((flags) => alive && flags && setSecondOpinion(flags.secondOpinion))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

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
      />
      <SettingsRow
        title={tr("casual.secondOpinion")}
        description={tr("casual.secondOpinionHint")}
        control={
          <SettingsToggle
            checked={secondOpinion ?? true}
            disabled={secondOpinion === undefined}
            onChange={(on) => {
              setSecondOpinion(on);
              void window.zeno.harnessFlags
                .set({ secondOpinion: on })
                .then((flags) => setSecondOpinion(flags.secondOpinion))
                .catch(() => setSecondOpinion(!on));
            }}
            testId="settings-second-opinion"
            aria-label={tr("casual.secondOpinion")}
          />
        }
        last
      />
    </SettingsSectionBlock>
  );
}
