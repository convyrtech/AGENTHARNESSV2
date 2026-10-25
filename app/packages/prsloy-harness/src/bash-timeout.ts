// Практика 4 (PLAN-alpha §3): таймаут bash + уход в фон, реестр процессов и портов.
// Источник: research/08-practitioners-research.md (2610.00917: 34 прогона Pi зависли без таймаута), ADR-3.
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describeProcess, looksLikeServer, ProcessRegistry } from "./process-registry.ts";
import type { ResolvedOptions } from "./options.ts";
import { scrubSecrets } from "./secret-scrub.ts";
import { contentText, withText, keepStructured } from "./text.ts";

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
    return undefined;
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
      "Manage background processes started by bash_background: action=list shows all with status and ports, action=logs shows the last output of one, action=stop kills one.",
    promptSnippet: "List, read logs of, or stop background processes",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("logs"), Type.Literal("stop")]),
      id: Type.Optional(Type.String({ description: "Process id like bg1 (for logs and stop)" })),
    }),
    async execute(_id, params) {
      if (params.action === "list") {
        const all = registry.list();
        const text = all.length ? all.map(describeProcess).join("\n") : "Фоновых процессов нет.";
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
