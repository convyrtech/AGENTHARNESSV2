/**
 * «Перенести чаты из других программ?» (#22 I1, research/25 §4.1): a checkbox per tool with its
 * counts, «Перенести / Не сейчас», a progress line, then what came over. The same panel serves
 * the first run (between the key and the folder) and settings. On the first run it steps aside
 * by itself when there is nothing to bring over, or when main has no import (older build).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ImportRunResult, ImportScanResult, ImportToolId } from "@zeno/contracts";
import { Button } from "@/components/ui/button";
import { LineLoader } from "@/components/motion/LineLoader";
import { t, type Locale, type MessageKey } from "@/lib/i18n";
import { countText, importKeys, importToolRows, saveImportedProjects } from "@/lib/session-import";

type Phase =
  | { kind: "scanning" }
  | { kind: "choose"; scan: ImportScanResult }
  | { kind: "nothing" }
  | { kind: "running"; done: number; total: number }
  | { kind: "done"; result: ImportRunResult }
  | { kind: "failed"; message: string };

export function ImportChats({
  locale,
  mode,
  onDone,
}: {
  locale: Locale;
  mode: "first-run" | "settings";
  onDone: () => void;
}) {
  const tr = useCallback(
    (key: MessageKey, vars?: Record<string, string | number>) =>
      t(
        locale,
        key,
        vars &&
          Object.fromEntries(Object.entries(vars).map(([name, value]) => [name, String(value)])),
      ),
    [locale],
  );
  const [phase, setPhase] = useState<Phase>({ kind: "scanning" });
  const [ticked, setTicked] = useState<Set<ImportToolId>>(new Set());

  useEffect(() => {
    const api = window.zeno.sessionImport;
    if (!api) {
      if (mode === "first-run") onDone();
      else setPhase({ kind: "nothing" });
      return;
    }
    let cancelled = false;
    api
      .scan()
      .then((scan) => {
        if (cancelled) return;
        const rows = importToolRows(scan);
        if (rows.length === 0) {
          if (mode === "first-run") onDone();
          else setPhase({ kind: "nothing" });
          return;
        }
        setTicked(new Set(rows.filter((r) => r.recommended).map((r) => r.tool)));
        setPhase({ kind: "choose", scan });
      })
      .catch(() => {
        // a failed scan never blocks the first run
        if (cancelled) return;
        if (mode === "first-run") onDone();
        else setPhase({ kind: "nothing" });
      });
    return () => {
      cancelled = true;
    };
  }, [mode, onDone]);

  const scan = phase.kind === "choose" ? phase.scan : undefined;
  const rows = useMemo(() => (scan ? importToolRows(scan) : []), [scan]);
  const keys = useMemo(() => (scan ? importKeys(scan, ticked) : []), [scan, ticked]);

  const run = useCallback(async () => {
    const api = window.zeno.sessionImport;
    if (!api || keys.length === 0) return;
    setPhase({ kind: "running", done: 0, total: keys.length });
    const unsubscribe = api.onProgress((progress) =>
      setPhase({ kind: "running", done: progress.done, total: progress.total }),
    );
    try {
      const result = await api.run(keys);
      saveImportedProjects(result.projects);
      setPhase({ kind: "done", result });
    } catch (cause) {
      setPhase({
        kind: "failed",
        message: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      unsubscribe();
    }
  }, [keys]);

  if (phase.kind === "scanning") {
    return (
      <div className="prsloy-import" data-testid="prsloy-import-scanning">
        <LineLoader className="mb-2" />
        <p className="prsloy-first-run-note">{tr("prsloy.import.scanning")}</p>
      </div>
    );
  }

  if (phase.kind === "nothing") {
    return (
      <div className="prsloy-import" data-testid="prsloy-import-nothing">
        <p className="prsloy-first-run-note">{tr("prsloy.import.nothing")}</p>
        <Button variant="outline" className="h-9" onClick={onDone}>
          {tr("prsloy.import.next")}
        </Button>
      </div>
    );
  }

  if (phase.kind === "running") {
    return (
      <div className="prsloy-import" data-testid="prsloy-import-running" aria-live="polite">
        <LineLoader className="mb-2" value={phase.total ? phase.done / phase.total : 0} />
        <p className="prsloy-first-run-note">
          {tr("prsloy.import.running", { done: phase.done, total: phase.total })}
        </p>
      </div>
    );
  }

  if (phase.kind === "done" || phase.kind === "failed") {
    const skipped =
      phase.kind === "done"
        ? Object.values(phase.result.skipped).reduce((sum, n) => sum + (n ?? 0), 0) -
          (phase.result.skipped.already ?? 0)
        : 0;
    return (
      <div className="prsloy-import" data-testid="prsloy-import-done" aria-live="polite">
        {phase.kind === "done" ? (
          <p className="prsloy-import-result" data-testid="prsloy-import-result">
            {countText(tr, locale, phase.result.imported, "prsloy.import.imported")}
          </p>
        ) : (
          <p role="alert" className="prsloy-first-run-error">
            {tr("prsloy.import.failed", { message: phase.message })}
          </p>
        )}
        {skipped > 0 ? (
          <p className="prsloy-first-run-note">{tr("prsloy.import.skipped", { count: skipped })}</p>
        ) : null}
        <Button className="h-10" data-testid="prsloy-import-next" onClick={onDone}>
          {tr("prsloy.import.next")}
        </Button>
      </div>
    );
  }

  return (
    <div className="prsloy-import" data-testid="prsloy-import-choose">
      {mode === "first-run" ? (
        <h1 className="prsloy-first-run-title">{tr("prsloy.import.title")}</h1>
      ) : null}
      <p className="prsloy-import-lead">{tr("prsloy.import.lead")}</p>
      <div className="prsloy-import-tools" role="group" aria-label={tr("prsloy.import.title")}>
        {rows.map((row) => (
          <label
            key={row.tool}
            className="prsloy-import-tool"
            data-testid={`prsloy-import-tool-${row.tool}`}
          >
            <input
              type="checkbox"
              checked={ticked.has(row.tool)}
              onChange={(event) => {
                const next = new Set(ticked);
                if (event.target.checked) next.add(row.tool);
                else next.delete(row.tool);
                setTicked(next);
              }}
            />
            <span className="prsloy-import-tool-name">{row.name}</span>
            <span className="prsloy-import-tool-count">
              {countText(tr, locale, row.chats, "prsloy.import.chats")}
              {countText(tr, locale, row.projects, "prsloy.import.projects")}
            </span>
          </label>
        ))}
      </div>
      <p className="prsloy-first-run-note">{tr("prsloy.import.note")}</p>
      <Button
        className="h-10"
        data-testid="prsloy-import-submit"
        disabled={keys.length === 0}
        onClick={() => void run()}
      >
        {tr("prsloy.import.submit")}
      </Button>
      <button
        type="button"
        className="prsloy-first-run-link"
        data-testid="prsloy-import-later"
        onClick={onDone}
      >
        {tr("prsloy.import.later")}
      </button>
    </div>
  );
}
