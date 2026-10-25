/** Settings → Behavior confirmations (moved out of SettingsPage.tsx for its budget). */
import { useState } from "react";
import type { MessageKey } from "../../lib/i18n.ts";
import {
  loadConfirmArchive,
  loadConfirmDelete,
  saveConfirmArchive,
  saveConfirmDelete,
} from "../../lib/behavior-prefs.ts";
import {
  SettingsPageShell,
  SettingsRow,
  SettingsSectionBlock,
  SettingsToggle,
} from "./SettingsPrimitives.tsx";

export function BehaviorSection(props: {
  tr: (key: MessageKey, vars?: Record<string, string>) => string;
}) {
  const { tr } = props;
  const [confirmDelete, setConfirmDelete] = useState(loadConfirmDelete);
  const [confirmArchive, setConfirmArchive] = useState(loadConfirmArchive);
  return (
    <SettingsPageShell title={tr("section.behavior")} testId="settings-behavior">
      <SettingsSectionBlock label={tr("settings.behavior")} testId="settings-behavior-options">
        <SettingsRow
          title={tr("settings.confirmDelete")}
          description={tr("settings.confirmDeleteHint")}
          control={
            <SettingsToggle
              checked={confirmDelete}
              onChange={(next) => {
                setConfirmDelete(next);
                saveConfirmDelete(next);
              }}
              testId="settings-confirm-delete"
              aria-label={tr("settings.confirmDelete")}
            />
          }
        />
        <SettingsRow
          title={tr("settings.confirmArchive")}
          description={tr("settings.confirmArchiveHint")}
          control={
            <SettingsToggle
              checked={confirmArchive}
              onChange={(next) => {
                setConfirmArchive(next);
                saveConfirmArchive(next);
              }}
              testId="settings-confirm-archive"
              aria-label={tr("settings.confirmArchive")}
            />
          }
          last
        />
      </SettingsSectionBlock>
    </SettingsPageShell>
  );
}
