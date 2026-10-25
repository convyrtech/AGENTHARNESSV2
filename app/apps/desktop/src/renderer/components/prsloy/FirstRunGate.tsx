/**
 * PRSLOY first run: «Вставьте ключ PRSLOY» → «Выберите папку проекта» → the app.
 * Functional shell only; the ui stream owns the look (reuses existing ui/ primitives).
 */
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { PrsloyState } from "@zeno/contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/lib/i18n";
import { cleanPastedKey, firstRunStep, gatewayErrorKey } from "@/lib/prsloy-first-run";
import { useShellStore } from "@/store/shell-store";

export function FirstRunGate({ children }: { children: ReactNode }) {
  const locale = useShellStore((s) => s.locale);
  const [state, setState] = useState<PrsloyState>();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [bypass, setBypass] = useState(false);

  useEffect(() => {
    let cancelled = false;
    window.zeno.prsloy
      .getState()
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch(() => {
        // No PRSLOY IPC (older main): never block the app.
        if (!cancelled) setBypass(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const submitKey = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      const cleaned = cleanPastedKey(key);
      if (!cleaned || busy) return;
      setBusy(true);
      setError(undefined);
      try {
        const result = await window.zeno.prsloy.setKey(cleaned);
        if (result.ok) {
          setKey("");
          setState(result.state);
        } else {
          setError(t(locale, gatewayErrorKey(result.code)));
        }
      } catch {
        setError(t(locale, "prsloy.error.network"));
      } finally {
        setBusy(false);
      }
    },
    [busy, key, locale],
  );

  const pickFolder = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const folder = await window.zeno.workspace.pickFolder();
      if (!folder) return;
      await window.zeno.workspace.openPath(folder);
      setState(await window.zeno.prsloy.getState());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const step = bypass ? "done" : firstRunStep(state);
  if (step === "done") return <>{children}</>;
  if (step === "loading") return <div className="h-screen w-screen bg-background" />;

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-background p-6">
      <div className="flex w-full max-w-sm flex-col gap-3" data-testid={`prsloy-first-run-${step}`}>
        {step === "key" ? (
          <form className="flex flex-col gap-3" onSubmit={(event) => void submitKey(event)}>
            <h1 className="text-lg font-medium">{t(locale, "prsloy.firstRun.keyTitle")}</h1>
            <Input
              autoFocus
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={key}
              placeholder={t(locale, "prsloy.firstRun.keyPlaceholder")}
              aria-invalid={error ? true : undefined}
              onChange={(event) => setKey(event.target.value)}
              disabled={busy}
            />
            <Button type="submit" disabled={busy || !cleanPastedKey(key)}>
              {busy
                ? t(locale, "prsloy.firstRun.keyChecking")
                : t(locale, "prsloy.firstRun.keySubmit")}
            </Button>
          </form>
        ) : (
          <>
            <h1 className="text-lg font-medium">{t(locale, "prsloy.firstRun.folderTitle")}</h1>
            <Button disabled={busy} onClick={() => void pickFolder()}>
              {t(locale, "prsloy.firstRun.folderPick")}
            </Button>
            {state?.keyMemoryOnly ? (
              <p className="text-sm text-muted-foreground">
                {t(locale, "prsloy.firstRun.keyMemoryOnly")}
              </p>
            ) : null}
          </>
        )}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
