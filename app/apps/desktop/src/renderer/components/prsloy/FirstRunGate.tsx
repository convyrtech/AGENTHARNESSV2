/**
 * PRSLOY first run: «Вставьте ключ PRSLOY» → chats from other agents → search → «Выберите папку
 * проекта» → the app. The two middle steps live in their own files and are optional.
 * Paper page, the PRSLOY wordmark, one field and one button per step.
 */
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Folder } from "lucide-react";
import type { PrsloyState } from "@zeno/contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/lib/i18n";
import {
  cleanPastedKey,
  firstRunStep,
  gatewayErrorKey,
  appSetupPercent,
  markFirstRunSeen,
  readFirstRunSeen,
  type FirstRunSeen,
} from "@/lib/prsloy-first-run";
import { isNonProjectWorkspacePath } from "@/lib/workspace";
import { mergeRecentFolders, readImportedProjects } from "@/lib/session-import";
import { useShellStore } from "@/store/shell-store";
import { LineLoader } from "@/components/motion/LineLoader";
import { FirstRunImport } from "./FirstRunImport";
import { FirstRunSearch } from "./FirstRunSearch";

/** Where people buy and copy their key. */
export const PRSLOY_KEY_URL = "https://prsloy.online";

const MAX_RECENT = 5;

function folderName(path: string): string {
  const parts = path.split(/[\\/]+/u).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function FirstRunGate({ children }: { children: ReactNode }) {
  const locale = useShellStore((s) => s.locale);
  const [state, setState] = useState<PrsloyState>();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [bypass, setBypass] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  /** «Другой сервер»: the gateway address, checked together with the key. */
  const [serverOpen, setServerOpen] = useState(false);
  const [server, setServer] = useState("");
  const [seen, setSeen] = useState<FirstRunSeen>(readFirstRunSeen);
  const passImport = useCallback(() => {
    markFirstRunSeen("import");
    setSeen((current) => ({ ...current, import: true }));
  }, []);
  const passSearch = useCallback(() => {
    markFirstRunSeen("search");
    setSeen((current) => ({ ...current, search: true }));
  }, []);

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

  const step = bypass ? "done" : firstRunStep(state, seen);

  useEffect(() => {
    if (step !== "folder") return;
    let cancelled = false;
    Promise.resolve()
      .then(() => window.zeno.workspace.listRecent())
      .then((paths) => {
        // folders of chats just brought over come first (#22)
        if (!cancelled) setRecent(mergeRecentFolders(readImportedProjects(), paths, MAX_RECENT));
      })
      .catch(() => {
        if (!cancelled) setRecent(readImportedProjects().slice(0, MAX_RECENT));
      });
    return () => {
      cancelled = true;
    };
  }, [step]);

  const submitKey = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      const cleaned = cleanPastedKey(key);
      if (!cleaned || busy) return;
      setBusy(true);
      setError(undefined);
      try {
        const address = serverOpen ? server.trim() : "";
        const result = address
          ? await window.zeno.prsloy.setKey(cleaned, address)
          : await window.zeno.prsloy.setKey(cleaned);
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
    [busy, key, locale, server, serverOpen],
  );

  const openFolder = useCallback(
    async (choose: () => Promise<string | undefined | null>) => {
      if (busy) return;
      setBusy(true);
      setError(undefined);
      try {
        const folder = await choose();
        if (!folder) return;
        // Never refuse silently: the user would stay stuck on this screen.
        if (isNonProjectWorkspacePath(folder)) {
          setError(t(locale, "prsloy.firstRun.folderRefused"));
          return;
        }
        await window.zeno.workspace.openPath(folder);
        const next = await window.zeno.prsloy.getState();
        setState(next);
        if (next.needsWorkspace) {
          setError(t(locale, "prsloy.firstRun.folderFailed", { path: folder }));
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [busy, locale],
  );

  // While runtimes unpack (first launch) refresh the percentage quietly.
  const setupPercent = appSetupPercent(state);
  useEffect(() => {
    if (setupPercent === undefined) return;
    const timer = setInterval(() => {
      window.zeno.prsloy
        .getState()
        .then(setState)
        .catch(() => undefined);
    }, 1500);
    return () => clearInterval(timer);
  }, [setupPercent === undefined]);

  if (step === "done") return <>{children}</>;
  if (step === "loading") return <div className="h-screen w-screen bg-background" />;

  return (
    <div className="prsloy-first-run">
      <div className="drag-region prsloy-first-run-drag" aria-hidden />
      <div className="prsloy-first-run-card" data-testid={`prsloy-first-run-${step}`}>
        <div className="brand-wordmark prsloy-first-run-wordmark">PRSLOY</div>
        {step === "import" ? (
          <FirstRunImport locale={locale} onDone={passImport} />
        ) : step === "search" ? (
          <FirstRunSearch locale={locale} onDone={passSearch} />
        ) : step === "key" ? (
          <form className="prsloy-first-run-form" onSubmit={(event) => void submitKey(event)}>
            <h1 className="prsloy-first-run-title">{t(locale, "prsloy.firstRun.keyTitle")}</h1>
            <Input
              autoFocus
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={key}
              className="h-10"
              placeholder={t(locale, "prsloy.firstRun.keyPlaceholder")}
              aria-label={t(locale, "prsloy.firstRun.keyTitle")}
              aria-invalid={error ? true : undefined}
              onChange={(event) => setKey(event.target.value)}
              disabled={busy}
            />
            {serverOpen ? (
              <Input
                type="url"
                spellCheck={false}
                value={server}
                className="h-10"
                placeholder={state?.defaultBaseUrl}
                aria-label={t(locale, "prsloy.settings.baseUrl")}
                data-testid="prsloy-server-input"
                onChange={(event) => setServer(event.target.value)}
                disabled={busy}
              />
            ) : null}
            {error ? (
              <p role="alert" className="prsloy-first-run-error">
                {error}
              </p>
            ) : null}
            <Button type="submit" className="h-10" disabled={busy || !cleanPastedKey(key)}>
              {busy
                ? t(locale, "prsloy.firstRun.keyChecking")
                : t(locale, "prsloy.firstRun.keySubmit")}
            </Button>
            <button
              type="button"
              className="prsloy-first-run-link"
              data-testid="prsloy-key-link"
              onClick={() =>
                void window.zeno.workspace.openExternal(PRSLOY_KEY_URL).catch(() => undefined)
              }
            >
              {t(locale, "prsloy.firstRun.keyWhere")}
            </button>
            {serverOpen ? null : (
              <button
                type="button"
                className="prsloy-first-run-link prsloy-first-run-link-quiet"
                data-testid="prsloy-server-link"
                onClick={() => {
                  setServer(state?.baseUrl ?? state?.defaultBaseUrl ?? "");
                  setServerOpen(true);
                }}
              >
                {t(locale, "prsloy.firstRun.otherServer")}
              </button>
            )}
          </form>
        ) : (
          <div className="prsloy-first-run-form">
            <h1 className="prsloy-first-run-title">{t(locale, "prsloy.firstRun.folderTitle")}</h1>
            <Button
              className="h-10"
              data-testid="prsloy-folder-pick"
              disabled={busy}
              onClick={() => void openFolder(() => window.zeno.workspace.pickFolder())}
            >
              {t(locale, "prsloy.firstRun.folderPick")}
            </Button>
            {recent.length > 0 ? (
              <div className="prsloy-first-run-recent" data-testid="prsloy-folder-recent">
                <p className="prsloy-first-run-recent-label">
                  {t(locale, "prsloy.firstRun.folderRecent")}
                </p>
                {recent.map((path) => (
                  <button
                    key={path}
                    type="button"
                    className="prsloy-first-run-recent-item"
                    title={path}
                    disabled={busy}
                    onClick={() => void openFolder(async () => path)}
                  >
                    <Folder className="size-4 shrink-0 opacity-70" strokeWidth={1.75} />
                    <span className="truncate">{folderName(path)}</span>
                  </button>
                ))}
              </div>
            ) : null}
            {error ? (
              <p role="alert" className="prsloy-first-run-error">
                {error}
              </p>
            ) : null}
            {state?.keyMemoryOnly ? (
              <p className="prsloy-first-run-note">{t(locale, "prsloy.firstRun.keyMemoryOnly")}</p>
            ) : null}
          </div>
        )}
        {setupPercent !== undefined ? (
          <div className="prsloy-first-run-note" data-testid="prsloy-app-setup">
            <LineLoader className="mb-2" value={Number(setupPercent) / 100} />
            {t(locale, "prsloy.setup.app", { percent: setupPercent })}
          </div>
        ) : null}
      </div>
    </div>
  );
}
