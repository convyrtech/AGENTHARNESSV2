/**
 * Settings → «Аккаунт» → «Поддержка»: one button that writes the support zip (core's
 * `window.zeno.prsloy.saveSupportReport`) to the desktop and shows it in its folder.
 */
import { useState } from "react";
import type { MessageKey } from "../../lib/i18n.ts";
import { SettingsButton, SettingsRow } from "../settings/SettingsPrimitives.tsx";

type Tr = (key: MessageKey, vars?: Record<string, string>) => string;

export function SupportReportRow(props: { tr: Tr }) {
  const { tr } = props;
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string }>();

  async function save() {
    setBusy(true);
    setResult(undefined);
    try {
      const saved = await window.zeno.prsloy.saveSupportReport();
      setResult(
        saved.ok
          ? { ok: true, text: tr("prsloy.support.saved", { name: saved.name }) }
          : { ok: false, text: tr("prsloy.support.failed") },
      );
    } catch {
      setResult({ ok: false, text: tr("prsloy.support.failed") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsRow
      title={tr("prsloy.support.title")}
      description={
        result ? (
          <span
            role={result.ok ? "status" : "alert"}
            className={result.ok ? undefined : "text-[var(--destructive)]"}
            data-testid="settings-support-result"
          >
            {result.text}
          </span>
        ) : (
          tr("prsloy.support.description")
        )
      }
      control={
        <SettingsButton
          type="button"
          variant="outline"
          disabled={busy}
          data-testid="settings-support-report"
          onClick={() => void save()}
        >
          {busy ? tr("prsloy.support.saving") : tr("prsloy.support.save")}
        </SettingsButton>
      }
      last
    />
  );
}
