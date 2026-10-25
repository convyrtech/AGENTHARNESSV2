/**
 * «Бот работает · Остановить · Журнал» (research/19 §1.10) at the end of the chat: one row
 * per background process the agent started that still runs — a person's name («Бот
 * Telegram», «Сайт на 127.0.0.1:8080»), how long it runs, «Остановить» and «Журнал» (the
 * last 200 lines, refreshed). A process that outlived the chat's turn shows when the chat
 * opens again, as long as it runs.
 */
import type { BackgroundProcStop } from "@zeno/contracts";
import { ScrollText, Square } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  type AgentProcess,
  agentProcesses,
  processName,
  uptimeLabel,
} from "../lib/agent-processes.ts";
import { t, type Locale } from "../lib/i18n.ts";
import type { TimelineItem } from "../lib/timeline.ts";
import "./code-preview-features.css";

const STATUS_EVERY_MS = 3000;
const LOG_EVERY_MS = 2000;

function ProcessLog(props: { locale: Locale; proc: AgentProcess }) {
  const [text, setText] = useState<string | undefined>();
  const box = useRef<HTMLPreElement>(null);
  // Newest lines in view, unless the owner scrolled up to read.
  const stuck = useRef(true);
  useEffect(() => {
    if (box.current && stuck.current) box.current.scrollTop = box.current.scrollHeight;
  }, [text]);
  useEffect(() => {
    let alive = true;
    const read = () =>
      void window.zeno.features
        .procLog(props.proc.logPath)
        .then((next) => alive && setText(next ?? ""))
        .catch(() => alive && setText(""));
    read();
    const timer = window.setInterval(read, LOG_EVERY_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [props.proc.logPath]);
  return (
    <pre
      ref={box}
      className="agent-proc-log"
      data-testid="agent-proc-log"
      onScroll={(event) => {
        const el = event.currentTarget;
        stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      }}
    >
      {text === undefined ? "" : text || t(props.locale, "features.proc.logEmpty")}
    </pre>
  );
}

export function AgentProcesses(props: { locale: Locale; items: readonly TimelineItem[] }) {
  const tr = (key: Parameters<typeof t>[1], vars?: Record<string, string>) =>
    t(props.locale, key, vars);
  const procs = useMemo(() => agentProcesses(props.items), [props.items]);
  const [alive, setAlive] = useState<Set<number>>(new Set());
  const [openLog, setOpenLog] = useState<string | undefined>();
  const [notes, setNotes] = useState<Record<string, BackgroundProcStop>>({});
  const [busy, setBusy] = useState<string | undefined>();
  const [now, setNow] = useState(Date.now());
  const pidsKey = procs.map((p) => p.pid).join(",");

  useEffect(() => {
    if (!pidsKey || !window.zeno?.features?.procStatus) return;
    let live = true;
    const check = () => {
      setNow(Date.now());
      void window.zeno.features
        .procStatus(pidsKey.split(",").map(Number))
        .then((list) => live && setAlive(new Set(list.filter((s) => s.alive).map((s) => s.pid))))
        .catch(() => undefined);
    };
    check();
    const timer = window.setInterval(check, STATUS_EVERY_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [pidsKey]);

  const running = procs.filter((p) => alive.has(p.pid) || notes[p.key]);
  if (running.length === 0) return null;

  async function stop(proc: AgentProcess) {
    setBusy(proc.key);
    const result = await window.zeno.features
      .procStop(proc.pid, proc.logPath)
      .catch((): BackgroundProcStop => ({ ok: false, reason: "still_running" }));
    setNotes((all) => ({ ...all, [proc.key]: result }));
    if (result.ok || result.reason === "gone") {
      setAlive((all) => new Set([...all].filter((pid) => pid !== proc.pid)));
    }
    setBusy(undefined);
  }

  return (
    <section
      className="agent-procs"
      data-testid="agent-procs"
      aria-label={tr("features.proc.title")}
    >
      {running.map((proc) => {
        const isAlive = alive.has(proc.pid);
        const note = notes[proc.key];
        return (
          <div key={proc.key} className="agent-proc" data-testid="agent-proc" data-alive={isAlive}>
            <div className="agent-proc-head">
              <span className="agent-proc-dot" aria-hidden data-alive={isAlive} />
              <span className="agent-proc-name">{processName(props.locale, proc)}</span>
              <span className="agent-proc-time" data-testid="agent-proc-status">
                {isAlive
                  ? uptimeLabel(props.locale, proc.startedAt, now)
                  : tr("features.proc.stopped")}
              </span>
              {isAlive ? (
                <button
                  type="button"
                  className="model-failure-retry"
                  data-testid="agent-proc-stop"
                  disabled={busy === proc.key}
                  onClick={() => void stop(proc)}
                >
                  <Square className="size-3" strokeWidth={2} />
                  {tr("features.proc.stop")}
                </button>
              ) : null}
              <button
                type="button"
                className="model-failure-retry"
                data-testid="agent-proc-log-toggle"
                aria-expanded={openLog === proc.key}
                onClick={() => setOpenLog((key) => (key === proc.key ? undefined : proc.key))}
              >
                <ScrollText className="size-3.5" strokeWidth={1.75} />
                {tr(openLog === proc.key ? "features.proc.hideLog" : "features.proc.log")}
              </button>
            </div>
            {note && !note.ok && note.reason !== "gone" ? (
              <p className="model-failure-hint" role="alert">
                {tr(
                  note.reason === "not_ours"
                    ? "features.proc.notOurs"
                    : "features.proc.stillRunning",
                )}
              </p>
            ) : null}
            {openLog === proc.key ? <ProcessLog locale={props.locale} proc={proc} /> : null}
          </div>
        );
      })}
    </section>
  );
}
