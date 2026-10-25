// Практика 4 (PLAN-alpha §3): таймаут bash + уход в фон, реестр процессов и портов.
// Источник: research/08-practitioners-research.md (2610.00917: 34 прогона Pi зависли без таймаута), ADR-3.
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  describeProcess,
  killPid,
  looksLikeServer,
  pidsListeningOn,
  ProcessRegistry,
} from "./process-registry.ts";
import type { ResolvedOptions } from "./options.ts";
import { scrubSecrets } from "./secret-scrub.ts";
import {
  cwdBefore,
  findBackgroundJobs,
  findKillCommands,
  isBackgroundServer,
  isProtectedTarget,
  replaceRanges,
  SAFE_PKILL_FUNCTION,
  safePkillCall,
} from "./shell-rewrite.ts";
import { appendText, contentText, withText, keepStructured } from "./text.ts";

const SHELL_TOOLS = new Set(["bash", "powershell"]);
const TIMEOUT_LINE = /Command timed out after (\d+(?:\.\d+)?) seconds/;

export function timeoutNote(seconds: string | number, maxSec: number): string {
  return (
    `[Процесс остановлен по таймауту ${seconds} с.] ` +
    `Если это сервер или вотчер — запусти его через bash_background. ` +
    `Если команде правда нужно больше времени — повтори с timeout (до ${maxSec} с).`
  );
}

export function installBashTimeout(pi: ExtensionAPI, opts: ResolvedOptions): ProcessRegistry {
  const registry = new ProcessRegistry(
    join(opts.outputDir, `bg-${process.pid}-${Date.now().toString(36)}`),
    opts.backgroundEnv,
    () => {
      if (opts.shellPath) return opts.shellPath;
      try {
        return pi.getSettings().shellPath;
      } catch {
        return undefined;
      }
    },
  );

  const notesById = new Map<string, string[]>();

  pi.on("tool_call", async (event, ctx) => {
    if (!SHELL_TOOLS.has(event.toolName)) return undefined;
    const input = event.input as { command?: unknown; timeout?: unknown };
    const requested =
      typeof input.timeout === "number" && input.timeout > 0 ? input.timeout : undefined;
    input.timeout = Math.min(requested ?? opts.bashTimeoutSec, opts.bashMaxTimeoutSec);

    if (
      event.toolName === "bash" &&
      typeof input.command === "string" &&
      looksLikeServer(input.command)
    ) {
      const started = await registry.start(input.command, ctx.cwd);
      const head = started.output.trim()
        ? `\nПервые строки вывода:\n${started.output.trim().slice(0, 2000)}`
        : "";
      const state =
        started.exitCode === undefined
          ? "Команда похожа на сервер, поэтому запущена в фоне, чтобы bash не завис."
          : `Команда похожа на сервер; в фоне она сразу завершилась с кодом ${started.exitCode}.`;
      return {
        block: true,
        // Причина блокировки не проходит через tool_result, поэтому чистим ключи здесь.
        reason: scrubSecrets(
          `${state}\n${describeProcess(started)}${head}\nЛоги и остановка: тул process.`,
        ).text,
      };
    }
    if (event.toolName === "bash" && typeof input.command === "string") {
      const rewrite = await rewriteShell(input.command, ctx.cwd);
      if (rewrite.block) return { block: true, reason: rewrite.block };
      if (rewrite.command !== input.command) input.command = rewrite.command;
      if (rewrite.notes.length) notesById.set(event.toolCallId, rewrite.notes);
    }
    return undefined;
  });

  /**
   * Серверы через `&` уходят в реестр, pkill/killall по ним — тоже; прочий pkill -f не трогает сам тул.
   * Переписываем команду, а не следим за PID после запуска: процесс из `(cmd &)` переподчиняется init,
   * и найти его потом надёжно нельзя, а запуск через реестр даёт PID, порт, лог и остановку с сессией.
   */
  async function rewriteShell(
    command: string,
    cwd: string,
  ): Promise<{ command: string; notes: string[]; block?: string }> {
    const notes: string[] = [];
    const ranges: { start: number; end: number; text: string }[] = [];
    let needSafePkill = false;

    for (const kill of findKillCommands(command)) {
      const matches = kill.target ? registry.matching(kill.target) : [];
      if (matches.length > 0 && kill.tool !== "taskkill") {
        for (const proc of matches) await registry.stop(proc.id);
        ranges.push({ start: kill.start, end: kill.end, text: ":" });
        notes.push(
          `«${kill.raw}» выполнено через реестр: остановлены ${matches.map((p) => p.id).join(", ")}.`,
        );
        continue;
      }
      if (isProtectedTarget(kill.target)) {
        return {
          command,
          notes,
          block: `«${kill.raw}» не выполнено: так убивается сам bash тула или приложение. Останови нужный процесс через process action=stop (id или port) или kill <PID>.`,
        };
      }
      if (kill.tool === "pkill" && kill.fullCommandLine) {
        if (process.platform === "win32") {
          return {
            command,
            notes,
            block: `«${kill.raw}» не выполнено: pkill -f находит и сам bash этой команды и убивает его. Останови сервер через process action=stop port=<порт> или kill <PID>.`,
          };
        }
        ranges.push({ start: kill.start, end: kill.end, text: safePkillCall(kill) });
        needSafePkill = true;
      }
    }

    const jobs = (findBackgroundJobs(command) ?? []).filter(
      (job) =>
        isBackgroundServer(job.command) &&
        cwdBefore(command, job.start, cwd) !== undefined &&
        !ranges.some((r) => r.start < job.end && job.start < r.end),
    );
    for (const job of jobs) {
      const started = await registry.start(job.command, cwdBefore(command, job.start, cwd) ?? cwd);
      ranges.push({ start: job.start, end: job.end + 1, text: ":;" });
      notes.push(
        `Сервер «${job.raw} &» запущен через реестр харнесса (он закроется с сессией): ${describeProcess(started)}. Логи и остановка: тул process.`,
      );
    }
    if (ranges.length === 0) return { command, notes };
    const rewritten = replaceRanges(command, ranges);
    return {
      command: needSafePkill ? `${SAFE_PKILL_FUNCTION}\n${rewritten}` : rewritten,
      notes: notes.map((n) => scrubSecrets(n).text),
    };
  }

  pi.on("tool_result", (event) => {
    const notes = notesById.get(event.toolCallId);
    if (!notes) return undefined;
    notesById.delete(event.toolCallId);
    return {
      content: appendText(event.content, notes.map((n) => `[${n}]`).join("\n")),
      ...keepStructured(event),
    };
  });

  pi.on("tool_result", (event) => {
    if (!SHELL_TOOLS.has(event.toolName) || !event.isError) return undefined;
    const text = contentText(event.content);
    const match = TIMEOUT_LINE.exec(text);
    if (!match) return undefined;
    return {
      content: withText(
        event.content,
        text.replace(TIMEOUT_LINE, timeoutNote(match[1] ?? "?", opts.bashMaxTimeoutSec)),
      ),
      ...keepStructured(event),
    };
  });

  pi.registerTool({
    name: "bash_background",
    label: "bash в фоне",
    description:
      "Start a long-running command (dev server, watcher) in the background and return at once with its id, pid, detected ports, log path and first output lines. Use it instead of bash for anything that does not exit by itself. Manage it with the process tool.",
    promptSnippet: "Start dev servers and watchers in the background",
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to run in the background" }),
      wait_seconds: Type.Optional(
        Type.Number({ description: "How long to wait for first output, default 4" }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const waitMs = Math.min(Math.max(params.wait_seconds ?? 4, 0.5), 30) * 1000;
      const started = await registry.start(params.command, ctx.cwd, waitMs);
      const out = started.output.trim();
      return {
        content: [
          {
            type: "text",
            text: `${describeProcess(started)}${out ? `\n${out.slice(-4000)}` : ""}`,
          },
        ],
        details: {
          id: started.id,
          pid: started.pid,
          ports: started.ports,
          logPath: started.logPath,
        },
      };
    },
  });

  pi.registerTool({
    name: "process",
    label: "фоновые процессы",
    description:
      "Manage background processes started by bash_background: action=list shows all with status and ports, action=logs shows the last output of one, action=stop kills one by id, or by port (also a server started outside the registry).",
    promptSnippet: "List, read logs of, or stop background processes",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("logs"), Type.Literal("stop")]),
      id: Type.Optional(Type.String({ description: "Process id like bg1 (for logs and stop)" })),
      port: Type.Optional(Type.Number({ description: "Stop whatever listens on this TCP port" })),
    }),
    async execute(_id, params) {
      if (params.action === "list") {
        const all = registry.list();
        const text = all.length ? all.map(describeProcess).join("\n") : "Фоновых процессов нет.";
        return { content: [{ type: "text", text }], details: undefined };
      }
      if (params.action === "stop" && params.port !== undefined && !params.id) {
        const own = registry.byPort(params.port);
        if (own) {
          const stopped = await registry.stop(own.id);
          return {
            content: [
              {
                type: "text",
                text: `${own.id} (порт ${params.port}) остановлен${stopped?.exitCode === undefined ? " не до конца" : ""}.`,
              },
            ],
            details: undefined,
          };
        }
        const pids = pidsListeningOn(params.port);
        if (pids.length === 0) {
          return {
            content: [{ type: "text", text: `Порт ${params.port} никто не слушает.` }],
            details: undefined,
          };
        }
        for (const pid of pids) killPid(pid);
        await new Promise((r) => setTimeout(r, 500));
        const left = pidsListeningOn(params.port);
        const text = left.length
          ? `Порт ${params.port}: процесс ${left.join(", ")} ещё работает.`
          : `Порт ${params.port} освобождён (остановлен PID ${pids.join(", ")}).`;
        return { content: [{ type: "text", text }], details: undefined };
      }
      const proc = params.id ? registry.get(params.id) : undefined;
      if (!proc || !params.id)
        throw new Error(
          `Нет процесса ${params.id ?? "(id не указан)"}. Список: process action=list.`,
        );
      if (params.action === "stop") {
        const stopped = await registry.stop(params.id);
        const text =
          stopped && stopped.exitCode !== undefined
            ? `${params.id} остановлен.`
            : `${params.id} не удалось остановить: процесс ещё работает (pid ${stopped?.pid ?? "?"}).`;
        return { content: [{ type: "text", text }], details: undefined };
      }
      return {
        content: [
          { type: "text", text: `${describeProcess(proc)}\n${registry.logs(params.id) ?? ""}` },
        ],
        details: undefined,
      };
    },
  });

  pi.on("session_shutdown", async () => {
    await registry.stopAll();
  });

  return registry;
}
