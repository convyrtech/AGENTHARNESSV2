/**
 * Settings → Агент: the HTTP idle timeout choices. Moved out of SettingsPage.tsx (line budget).
 */
import type { MessageKey } from "./i18n.ts";

/** pi HTTP_IDLE_TIMEOUT_CHOICES + Zeno longer presets (ms → i18n). */
export const HTTP_IDLE_TIMEOUT_PRESETS: ReadonlyArray<{ ms: number; labelKey: MessageKey }> = [
  { ms: 30_000, labelKey: "piSettings.httpIdle30s" },
  { ms: 60_000, labelKey: "piSettings.httpIdle1m" },
  { ms: 120_000, labelKey: "piSettings.httpIdle2m" },
  { ms: 300_000, labelKey: "piSettings.httpIdle5m" },
  { ms: 900_000, labelKey: "piSettings.httpIdle15m" },
  { ms: 1_800_000, labelKey: "piSettings.httpIdle30m" },
  { ms: 3_600_000, labelKey: "piSettings.httpIdle60m" },
  { ms: 0, labelKey: "piSettings.httpIdleDisabled" },
];

export function httpIdleTimeoutOptions(
  tr: (key: MessageKey, vars?: Record<string, string>) => string,
  currentMs: number | undefined,
): Array<{ value: string; label: string }> {
  const options = HTTP_IDLE_TIMEOUT_PRESETS.map((row) => ({
    value: String(row.ms),
    label: tr(row.labelKey),
  }));
  if (currentMs === undefined || !Number.isFinite(currentMs)) return options;
  const key = String(Math.floor(currentMs));
  if (options.some((opt) => opt.value === key)) return options;
  // Surface pi/custom values not in the preset list (so the select can echo them).
  return [
    {
      value: key,
      label:
        currentMs === 0
          ? tr("piSettings.httpIdleDisabled")
          : tr("piSettings.httpIdleCustom", { seconds: String(Math.round(currentMs / 1000)) }),
    },
    ...options,
  ];
}
