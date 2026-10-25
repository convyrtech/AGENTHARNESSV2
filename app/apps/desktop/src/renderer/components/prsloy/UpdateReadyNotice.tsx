/**
 * One quiet notice when an update has finished downloading in the background:
 * «Обновление готово — перезапустить». Click restarts into the new version; × hides it
 * for this session. Nothing is shown while checking / downloading or on errors.
 */
import { useEffect, useState } from "react";
import type { AppUpdateStatus } from "@zeno/contracts";
import { t } from "@/lib/i18n";
import { useShellStore } from "@/store/shell-store";

export function UpdateReadyNotice() {
  const locale = useShellStore((s) => s.locale);
  const [status, setStatus] = useState<AppUpdateStatus>();
  const [dismissed, setDismissed] = useState(false);

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

  if (dismissed || status?.state !== "downloaded") return null;
  return (
    <div
      role="status"
      data-testid="prsloy-update-ready"
      className="fixed bottom-4 left-4 z-50 flex items-center gap-1 rounded-md border border-border bg-background/95 py-1 pl-3 pr-1 text-sm shadow-sm"
    >
      <button
        type="button"
        className="hover:underline"
        onClick={() => void window.zeno.app.quitAndInstall()}
      >
        {t(locale, "prsloy.update.ready")}
      </button>
      <button
        type="button"
        aria-label={t(locale, "prsloy.update.dismiss")}
        className="px-1.5 text-muted-foreground hover:text-foreground"
        onClick={() => setDismissed(true)}
      >
        ×
      </button>
    </div>
  );
}
