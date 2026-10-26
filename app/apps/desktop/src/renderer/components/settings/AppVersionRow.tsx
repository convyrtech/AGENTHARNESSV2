import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import type { AppUpdateStatus } from "@zeno/contracts";
import type { MessageKey } from "../../lib/i18n.ts";
import { SettingsButton, SettingsRow } from "./SettingsPrimitives.tsx";

type Tr = (key: MessageKey, vars?: Record<string, string>) => string;
type CopyState = "idle" | "copying" | "copied" | "error";

/** The update status already carries app.getVersion(); no second version source is needed. */
export function AppVersionRow(props: { tr: Tr }) {
  const { tr } = props;
  const [status, setStatus] = useState<AppUpdateStatus>();
  const [copyState, setCopyState] = useState<CopyState>("idle");

  useEffect(() => {
    let cancelled = false;
    const app = window.zeno?.app;
    if (!app) return;
    void app
      .getUpdateStatus()
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch(() => undefined);
    const unsubscribe = app.onUpdateStatus((next) => {
      if (!cancelled) setStatus(next);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const version = status?.currentVersion.trim();
  if (!version) return null;

  async function copyVersion() {
    if (copyState === "copying") return;
    setCopyState("copying");
    try {
      await navigator.clipboard.writeText(version!);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  }

  const message =
    copyState === "copied"
      ? tr("prsloy.settings.versionCopied")
      : copyState === "error"
        ? tr("prsloy.settings.versionCopyFailed")
        : undefined;

  return (
    <SettingsRow
      title={tr("app.name")}
      description={
        message ? (
          <span role={copyState === "error" ? "alert" : "status"}>{message}</span>
        ) : undefined
      }
      control={
        <SettingsButton
          type="button"
          variant="ghost"
          className="font-mono"
          aria-label={tr("prsloy.settings.versionCopy")}
          title={tr("prsloy.settings.versionCopy")}
          data-testid="settings-app-version"
          disabled={copyState === "copying"}
          onClick={() => void copyVersion()}
        >
          {version}
          {copyState === "copied" ? (
            <Check className="size-3.5" aria-hidden />
          ) : (
            <Copy className="size-3.5" aria-hidden />
          )}
        </SettingsButton>
      }
      last
    />
  );
}
