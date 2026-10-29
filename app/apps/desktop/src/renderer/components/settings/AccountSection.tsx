/**
 * Settings → «Аккаунт»: the PRSLOY key (masked, «Сменить ключ»), the gateway address and
 * the gateway address. Key and address go through core's `window.zeno.prsloy` IPC, which checks
 * them against the gateway before saving; refusals come back as codes shown in Russian.
 */
import { useEffect, useState, type FormEvent } from "react";
import type { PrsloyKeyResult, PrsloyState } from "@zeno/contracts";
import type { Locale, MessageKey } from "../../lib/i18n.ts";
import { cleanPastedKey, gatewayErrorKey } from "../../lib/prsloy-first-run.ts";
import { balanceAgeMinutes, balanceIsLow } from "../../lib/prsloy-balance.ts";
import { formatRub } from "../../lib/rub-cost.ts";
import { useShellStore } from "../../store/shell-store.ts";
import { SupportReportRow } from "../prsloy/SupportReportRow.tsx";
import {
  SettingsButton,
  SettingsInput,
  SettingsPageShell,
  SettingsRow,
  SettingsSectionBlock,
} from "./SettingsPrimitives.tsx";
import { AppVersionRow } from "./AppVersionRow.tsx";

type Tr = (key: MessageKey, vars?: Record<string, string>) => string;

/** The gateway page where the key is topped up — same origin the app already talks to. */
function topUpUrl(baseUrl: string): string | undefined {
  try {
    const url = new URL(baseUrl);
    return url.protocol === "https:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

function balanceDescription(
  balance: PrsloyState["balance"],
  locale: Locale,
  baseUrl: string,
  tr: Tr,
): string | undefined {
  if (!balance) return undefined;
  const parts: string[] = [];
  if (balanceIsLow(balance)) {
    parts.push(tr("prsloy.balance.low", { amount: formatRub(balance.remainingRub, locale) }));
  }
  const site = topUpUrl(baseUrl);
  if (site) parts.push(tr("prsloy.balance.settingsHint", { site }));
  parts.push(
    tr("prsloy.balance.updated", { minutes: String(balanceAgeMinutes(balance.fetchedAt)) }),
  );
  return parts.join(" · ");
}

export function AccountSection(props: { tr: Tr }) {
  const { tr } = props;
  const locale = useShellStore((s) => s.locale);
  const [state, setState] = useState<PrsloyState>();
  const [changingKey, setChangingKey] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const [urlDraft, setUrlDraft] = useState("");
  const [busy, setBusy] = useState<"key" | "url">();
  const [error, setError] = useState<{ field: "key" | "url"; text: string }>();
  const [saved, setSaved] = useState<"key" | "url">();

  useEffect(() => {
    let cancelled = false;
    window.zeno.prsloy
      .getState()
      .then((next) => {
        if (cancelled) return;
        setState(next);
        setUrlDraft(next.baseUrl);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  async function run(field: "key" | "url", call: () => Promise<PrsloyKeyResult>) {
    setBusy(field);
    setError(undefined);
    setSaved(undefined);
    try {
      const result = await call();
      if (!result.ok) {
        setError({ field, text: tr(gatewayErrorKey(result.code)) });
        return false;
      }
      setState(result.state);
      setUrlDraft(result.state.baseUrl);
      setSaved(field);
      return true;
    } catch {
      setError({ field, text: tr("prsloy.error.network") });
      return false;
    } finally {
      setBusy(undefined);
    }
  }

  async function submitKey(event: FormEvent) {
    event.preventDefault();
    const cleaned = cleanPastedKey(keyDraft);
    if (!cleaned) return;
    if (await run("key", () => window.zeno.prsloy.setKey(cleaned))) {
      setKeyDraft("");
      setChangingKey(false);
    }
  }

  const urlDirty = Boolean(state) && urlDraft.trim() !== state?.baseUrl;
  const notDefault = Boolean(state) && state?.baseUrl !== state?.defaultBaseUrl;
  const message = (field: "key" | "url") =>
    error?.field === field ? (
      <span className="text-[var(--destructive)]" role="alert">
        {error.text}
      </span>
    ) : saved === field ? (
      <span role="status">{tr("prsloy.settings.saved")}</span>
    ) : undefined;

  return (
    <SettingsPageShell title={tr("section.account")} testId="settings-account">
      {state ? (
        <SettingsSectionBlock label={tr("prsloy.settings.keyGroup")} testId="settings-account-key">
          <SettingsRow
            title={tr("prsloy.settings.key")}
            description={
              message("key") ??
              (state.keyMemoryOnly ? tr("prsloy.firstRun.keyMemoryOnly") : undefined)
            }
            control={
              changingKey ? (
                <form className="flex items-center gap-2" onSubmit={(e) => void submitKey(e)}>
                  <SettingsInput
                    autoFocus
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    className="w-56"
                    placeholder={tr("prsloy.firstRun.keyPlaceholder")}
                    aria-label={tr("prsloy.settings.keyChange")}
                    data-testid="settings-account-key-input"
                    value={keyDraft}
                    disabled={busy === "key"}
                    onChange={(event) => setKeyDraft(event.target.value)}
                  />
                  <SettingsButton
                    type="submit"
                    disabled={busy === "key" || !cleanPastedKey(keyDraft)}
                  >
                    {busy === "key"
                      ? tr("prsloy.firstRun.keyChecking")
                      : tr("prsloy.settings.save")}
                  </SettingsButton>
                  <SettingsButton
                    type="button"
                    variant="ghost"
                    disabled={busy === "key"}
                    onClick={() => {
                      setChangingKey(false);
                      setKeyDraft("");
                      setError(undefined);
                    }}
                  >
                    {tr("common.cancel")}
                  </SettingsButton>
                </form>
              ) : (
                <div className="flex items-center gap-3">
                  <span className="font-mono text-[13px]" data-testid="settings-account-masked">
                    {state.hasKey ? state.maskedKey : tr("prsloy.settings.noKey")}
                  </span>
                  <SettingsButton
                    type="button"
                    variant="outline"
                    data-testid="settings-account-key-change"
                    onClick={() => {
                      setChangingKey(true);
                      setSaved(undefined);
                    }}
                  >
                    {tr("prsloy.settings.keyChange")}
                  </SettingsButton>
                </div>
              )
            }
          />
          <SettingsRow
            title={tr("prsloy.balance.settingsLabel")}
            description={balanceDescription(state.balance, locale, state.baseUrl, tr)}
            control={
              <span data-testid="settings-account-balance">
                {state.balance ? formatRub(state.balance.remainingRub, locale) : "—"}
              </span>
            }
          />
          <SettingsRow
            title={tr("prsloy.settings.baseUrl")}
            description={message("url")}
            wrapControl
            control={
              <div className="flex flex-wrap items-center justify-end gap-2">
                <SettingsInput
                  className="w-56 max-w-full"
                  spellCheck={false}
                  value={urlDraft}
                  data-testid="settings-account-url"
                  aria-label={tr("prsloy.settings.baseUrl")}
                  disabled={busy === "url"}
                  onChange={(event) => setUrlDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && urlDirty) {
                      void run("url", () => window.zeno.prsloy.setBaseUrl(urlDraft.trim()));
                    }
                  }}
                />
                {urlDirty ? (
                  <SettingsButton
                    type="button"
                    disabled={busy === "url" || !urlDraft.trim()}
                    onClick={() =>
                      void run("url", () => window.zeno.prsloy.setBaseUrl(urlDraft.trim()))
                    }
                  >
                    {busy === "url"
                      ? tr("prsloy.firstRun.keyChecking")
                      : tr("prsloy.settings.save")}
                  </SettingsButton>
                ) : notDefault ? (
                  <SettingsButton
                    type="button"
                    variant="ghost"
                    disabled={busy === "url"}
                    onClick={() =>
                      void run("url", () => window.zeno.prsloy.setBaseUrl(state.defaultBaseUrl))
                    }
                  >
                    {tr("prsloy.settings.baseUrlReset")}
                  </SettingsButton>
                ) : null}
              </div>
            }
            last
          />
        </SettingsSectionBlock>
      ) : null}
      <SettingsSectionBlock label={tr("prsloy.support.group")} testId="settings-account-support">
        <SupportReportRow tr={tr} />
      </SettingsSectionBlock>
      <SettingsSectionBlock
        label={tr("prsloy.settings.versionGroup")}
        testId="settings-account-version"
      >
        <AppVersionRow tr={tr} />
      </SettingsSectionBlock>
    </SettingsPageShell>
  );
}
