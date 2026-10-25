/**
 * First launch, after the key and the folder: if the runtimes (Node, Python, Git) are still
 * unpacking, the first agent turn waits for them (prepareTurn). Say so instead of silence:
 * «Готовлю инструменты для агента… N%». Gone as soon as they are ready; never shown again.
 */
import { useEffect, useState } from "react";
import type { PrsloyState } from "@zeno/contracts";
import { t } from "@/lib/i18n";
import { appSetupPercent } from "@/lib/prsloy-first-run";
import { useShellStore } from "@/store/shell-store";
import { LineLoader } from "@/components/motion/LineLoader";

export function ToolsSetupNotice({ pollMs = 1500 }: { pollMs?: number }) {
  const locale = useShellStore((s) => s.locale);
  const [state, setState] = useState<PrsloyState>();
  const percent = appSetupPercent(state);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = () => {
      const prsloy = window.zeno?.prsloy;
      if (!prsloy) return;
      void prsloy
        .getState()
        .then((next) => {
          if (cancelled) return;
          setState(next);
          // Keep asking only while something unpacks; then stop for good.
          if (appSetupPercent(next) !== undefined) timer = setTimeout(poll, pollMs);
        })
        .catch(() => undefined);
    };
    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [pollMs]);

  if (percent === undefined) return null;
  return (
    <div
      role="status"
      data-testid="prsloy-turn-setup"
      className="fixed bottom-4 left-4 z-50 w-72 max-w-[calc(100vw-2rem)] rounded-md border border-border bg-background/95 px-3 py-2 text-sm shadow-sm"
    >
      <LineLoader className="mb-2" value={Number(percent) / 100} />
      {t(locale, "prsloy.setup.tools", { percent })}
    </div>
  );
}
