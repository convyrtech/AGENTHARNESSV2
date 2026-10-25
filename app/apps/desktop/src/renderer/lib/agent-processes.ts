/**
 * «Бот работает · Остановить · Журнал» (research/19 §1.10): the background processes the
 * agent started in this chat, read from the harness's tool results — `bash_background`
 * ({id, pid, logPath, ports}) and a server command the harness moved into its registry
 * (`details.prsloyServer` with `servers`). Main says which still run.
 */
import { t, type Locale } from "./i18n.ts";
import type { TimelineItem } from "./timeline.ts";

export type AgentProcess = {
  /** The log path: unique per process. */
  key: string;
  id: string;
  pid: number;
  logPath: string;
  ports: number[];
  command: string;
  startedAt?: number | undefined;
};

type Tool = Extract<TimelineItem, { kind: "tool" }>;

function procFrom(
  raw: unknown,
  command: string,
  startedAt: number | undefined,
): AgentProcess | undefined {
  const value = raw as { id?: unknown; pid?: unknown; logPath?: unknown; ports?: unknown } | null;
  if (!value || typeof value.logPath !== "string" || !value.logPath) return undefined;
  if (typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0)
    return undefined;
  const ports = Array.isArray(value.ports)
    ? value.ports.filter((p): p is number => Number.isInteger(p) && p > 0 && p < 65536)
    : [];
  return {
    key: value.logPath,
    id: typeof value.id === "string" ? value.id : "",
    pid: value.pid,
    logPath: value.logPath,
    ports,
    command,
    startedAt,
  };
}

/** Every process the chat's tool results started, oldest first, each once. */
export function agentProcesses(items: readonly TimelineItem[]): AgentProcess[] {
  const found = new Map<string, AgentProcess>();
  for (const item of items) {
    if (item.kind !== "tool" || item.status !== "completed") continue;
    const tool = item as Tool;
    const rawCommand = (tool.args as { command?: unknown } | undefined)?.command;
    const command = typeof rawCommand === "string" ? rawCommand.trim() : "";
    const startedAt = tool.timestamp ? Date.parse(tool.timestamp) : undefined;
    const at = Number.isNaN(startedAt) ? undefined : startedAt;
    const details = tool.details as { prsloyServer?: unknown; servers?: unknown } | undefined;
    const raws =
      tool.toolName === "bash_background"
        ? [details]
        : details?.prsloyServer && Array.isArray(details.servers)
          ? details.servers
          : [];
    for (const raw of raws) {
      const proc = procFrom(raw, command, at);
      if (proc && !found.has(proc.key)) found.set(proc.key, proc);
    }
  }
  return [...found.values()];
}

/** «Бот Telegram», «Сайт на 127.0.0.1:8080», else the command itself, short. */
export function processName(locale: Locale, proc: AgentProcess): string {
  if (/telegram|aiogram|telebot|grammy|\bbot\b|bot\.(py|js|ts)/iu.test(proc.command)) {
    return t(locale, "features.proc.bot");
  }
  if (proc.ports[0]) return t(locale, "features.proc.site", { port: String(proc.ports[0]) });
  const short = proc.command.length > 40 ? `${proc.command.slice(0, 40)}…` : proc.command;
  return t(locale, "features.proc.command", { command: short || proc.id });
}

/** «работает 5 мин», «работает 1 ч 20 мин», «работает меньше минуты». */
export function uptimeLabel(locale: Locale, startedAt: number | undefined, now: number): string {
  const minutes = startedAt === undefined ? 0 : Math.max(0, Math.floor((now - startedAt) / 60_000));
  const time =
    minutes < 1
      ? t(locale, "features.proc.lessMinute")
      : minutes < 60
        ? t(locale, "features.proc.minutes", { n: String(minutes) })
        : t(locale, "features.proc.hours", {
            h: String(Math.floor(minutes / 60)),
            m: String(minutes % 60),
          });
  return t(locale, "features.proc.running", { time });
}
