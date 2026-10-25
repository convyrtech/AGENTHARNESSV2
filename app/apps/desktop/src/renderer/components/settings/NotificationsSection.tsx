/** Settings → Notifications (moved out of SettingsPage.tsx for its line budget). */
import { useState } from "react";
import { type MessageKey } from "../../lib/i18n.ts";
import { requestMacNotificationPermission } from "../../lib/notification-permission.ts";
import {
  loadNotificationPrefs,
  patchNotificationPrefs,
  type NotificationPrefs,
} from "../../lib/notification-prefs.ts";
import { useShellStore } from "../../store/shell-store.ts";
import {
  SettingsPageShell,
  SettingsPillButton,
  SettingsRow,
  SettingsSectionBlock,
  SettingsToggle,
} from "./SettingsPrimitives.tsx";

export function NotificationsSection(props: {
  tr: (key: MessageKey, vars?: Record<string, string>) => string;
}) {
  const { tr } = props;
  const showAppError = useShellStore((s) => s.showAppError);
  const [prefs, setPrefs] = useState<NotificationPrefs>(loadNotificationPrefs);
  const [testing, setTesting] = useState(false);

  function update(patch: Partial<NotificationPrefs>) {
    setPrefs(patchNotificationPrefs(patch));
  }

  async function updateEnabled(enabled: boolean) {
    update({ enabled });
    if (enabled && !(await requestMacNotificationPermission())) {
      showAppError(tr("notify.permissionDenied"));
    }
  }

  async function sendTest() {
    setTesting(true);
    try {
      if (!(await requestMacNotificationPermission())) {
        showAppError(tr("notify.permissionDenied"));
        return;
      }
      // Test always posts even when focused (diagnostics).
      const ok = await window.zeno.notifications.show({
        title: tr("notify.testTitle"),
        body: tr("notify.testBody"),
        silent: !prefs.sound,
        force: true,
      });
      if (!ok) {
        showAppError(tr("notify.testFailed"));
      }
    } catch (error) {
      showAppError(error instanceof Error ? error.message : tr("notify.testFailed"));
    } finally {
      setTesting(false);
    }
  }

  return (
    <SettingsPageShell title={tr("section.notifications")} testId="settings-notifications">
      <SettingsSectionBlock label={tr("section.notifications")} testId="settings-notify-options">
        <SettingsRow
          title={tr("notify.master")}
          description={tr("notify.masterHint")}
          control={
            <SettingsToggle
              checked={prefs.enabled}
              onChange={(on) => void updateEnabled(on)}
              testId="settings-notify-enabled"
              aria-label={tr("notify.master")}
            />
          }
        />
        <SettingsRow
          title={tr("notify.onComplete")}
          description={tr("notify.onCompleteHint")}
          control={
            <SettingsToggle
              checked={prefs.onComplete}
              onChange={(on) => update({ onComplete: on })}
              testId="settings-notify-complete"
              disabled={!prefs.enabled}
              aria-label={tr("notify.onComplete")}
            />
          }
        />
        <SettingsRow
          title={tr("notify.onError")}
          description={tr("notify.onErrorHint")}
          control={
            <SettingsToggle
              checked={prefs.onError}
              onChange={(on) => update({ onError: on })}
              testId="settings-notify-error"
              disabled={!prefs.enabled}
              aria-label={tr("notify.onError")}
            />
          }
        />
        <SettingsRow
          title={tr("notify.onHostCrash")}
          description={tr("notify.onHostCrashHint")}
          control={
            <SettingsToggle
              checked={prefs.onHostCrash}
              onChange={(on) => update({ onHostCrash: on })}
              testId="settings-notify-crash"
              disabled={!prefs.enabled}
              aria-label={tr("notify.onHostCrash")}
            />
          }
        />
        <SettingsRow
          title={tr("notify.onlyWhenUnfocused")}
          description={tr("notify.onlyWhenUnfocusedHint")}
          control={
            <SettingsToggle
              checked={prefs.onlyWhenUnfocused}
              onChange={(on) => update({ onlyWhenUnfocused: on })}
              testId="settings-notify-unfocused"
              disabled={!prefs.enabled}
              aria-label={tr("notify.onlyWhenUnfocused")}
            />
          }
        />
        <SettingsRow
          title={tr("notify.sound")}
          description={tr("notify.soundHint")}
          control={
            <SettingsToggle
              checked={prefs.sound}
              onChange={(on) => update({ sound: on })}
              testId="settings-notify-sound"
              disabled={!prefs.enabled}
              aria-label={tr("notify.sound")}
            />
          }
          last
        />
      </SettingsSectionBlock>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <SettingsPillButton
          label={testing ? "…" : tr("notify.test")}
          testId="settings-notify-test"
          disabled={!prefs.enabled || testing}
          onClick={() => void sendTest()}
        />
        <SettingsPillButton
          label={tr("notify.openSystem")}
          testId="settings-notify-open-system"
          onClick={() => void window.zeno.notifications.openSystemSettings()}
        />
      </div>
    </SettingsPageShell>
  );
}
