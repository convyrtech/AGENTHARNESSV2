/** Settings → Environment panel visibility (moved out of SettingsPage.tsx for its budget). */
import { useState } from "react";
import type { MessageKey } from "../../lib/i18n.ts";
import {
  loadEnvPanelVisibility,
  setEnvPanelSectionVisible,
  type EnvPanelSectionId,
} from "../../lib/env-panel-prefs.ts";
import {
  SettingsPageShell,
  SettingsRow,
  SettingsSectionBlock,
  SettingsToggle,
} from "./SettingsPrimitives.tsx";

export function EnvironmentSection(props: {
  tr: (key: MessageKey, vars?: Record<string, string>) => string;
}) {
  const { tr } = props;
  const [visibility, setVisibility] = useState(loadEnvPanelVisibility);

  function toggle(id: EnvPanelSectionId, on: boolean) {
    const next = setEnvPanelSectionVisible(id, on);
    setVisibility(next);
    window.dispatchEvent(new Event("zeno-env-panel-prefs"));
  }

  const rows: Array<{ id: EnvPanelSectionId; titleKey: MessageKey; descKey: MessageKey }> = [
    { id: "changes", titleKey: "env.section.changes", descKey: "env.section.changesDesc" },
    { id: "cwd", titleKey: "env.section.cwd", descKey: "env.section.cwdDesc" },
    { id: "branch", titleKey: "env.section.branch", descKey: "env.section.branchDesc" },
    {
      id: "gitActions",
      titleKey: "env.section.gitActions",
      descKey: "env.section.gitActionsDesc",
    },
    { id: "openIn", titleKey: "env.section.openIn", descKey: "env.section.openInDesc" },
    {
      id: "localServices",
      titleKey: "env.section.localServices",
      descKey: "env.section.localServicesDesc",
    },
  ];

  return (
    <SettingsPageShell title={tr("section.environment")} testId="settings-environment">
      <SettingsSectionBlock label={tr("env.title")} testId="settings-env-visibility">
        {rows.map((row, index) => (
          <SettingsRow
            key={row.id}
            title={tr(row.titleKey)}
            description={tr(row.descKey)}
            control={
              <SettingsToggle
                checked={visibility[row.id]}
                onChange={(on) => toggle(row.id, on)}
                testId={`settings-env-${row.id}`}
                aria-label={tr(row.titleKey)}
              />
            }
            last={index === rows.length - 1}
          />
        ))}
      </SettingsSectionBlock>
    </SettingsPageShell>
  );
}
