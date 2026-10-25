/**
 * After an Agent Host crash, main restarts it on the same session. Say so once, quietly:
 * «Агент перезапущен после сбоя — разговор сохранён». Hides itself after a few seconds.
 */
import { useEffect, useRef, useState } from "react";
import { t } from "@/lib/i18n";
import { useShellStore } from "@/store/shell-store";

export const HOST_RECOVERY_NOTICE_MS = 8_000;

export function HostRecoveryNotice() {
  const locale = useShellStore((s) => s.locale);
  const [visible, setVisible] = useState(false);
  const crashedRef = useRef(false);

  useEffect(() => {
    const host = window.zeno?.host;
    if (!host) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = host.onEvent((event) => {
      if (event.type === "host.crashed") crashedRef.current = true;
      if (event.type === "host.restarted" && crashedRef.current) {
        crashedRef.current = false;
        setVisible(true);
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => setVisible(false), HOST_RECOVERY_NOTICE_MS);
      }
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, []);

  if (!visible) return null;
  return (
    <div
      role="status"
      data-testid="prsloy-host-recovered"
      className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md border border-border bg-background/95 px-3 py-1 text-sm text-muted-foreground shadow-sm"
    >
      {t(locale, "prsloy.host.restarted")}
    </div>
  );
}
