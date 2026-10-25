// Замер на казуальных задачах: каждая задача — свежая папка и сессия того же рантайма, что у агент-хоста
// приложения (createPixRuntime + граница записи + харнесс), настоящая модель через --base-url или фейковая.
// Пишет успех проверки кодом, время, вызовы, деньги из usage и вмешательства харнесса.
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPixRuntime, type ZenoRuntimeHandle } from "../../agent-runtime/src/index.ts";
import {
  createWriteBoundary,
  ANSWER_NO,
  ANSWER_YES,
} from "../../../apps/desktop/src/agent-host/write-boundary.ts";
import {
  buildPrsloyModelsJsonProvider,
  PRSLOY_PROVIDER_ID,
} from "../../../apps/desktop/src/shared/prsloy-config.ts";
import { createPrsloyHarness, harnessStats, installReusePrompt } from "../src/index.ts";
import { resolveOptions } from "../src/options.ts";
import { closeSharedProxy } from "../src/reliability.ts";
import {
  messageText,
  ScriptedOpenAiServer,
  type ScriptedReply,
} from "../test/scripted-openai-server.ts";

export const TASKS_DIR = join(dirname(fileURLToPath(import.meta.url)), "tasks");

export interface BenchOptions {
  /** id задач; по умолчанию все из bench/tasks. */
  tasks?: string[];
  harness: boolean;
  /** `провайдер/модель`, по умолчанию prsloy/deepseek-v4.1-flash-1017. */
  model: string;
  baseUrl?: string;
  /** Ключ шлюза: только из окружения, в файлы не пишется. */
  key?: string;
  /** Фейковая модель отвечает заготовкой задачи (fake.json) — для CI. */
  fake?: boolean;
  outDir: string;
  timeoutSec: number;
  /** Ответ на вопрос «менять файлы вне проекта?»: казуал по умолчанию отказывается. */
  allowOutside?: boolean;
  /** Уроки (флаг "lessons" в prsloy-harness.json агента, как в приложении). По умолчанию вкл. */
  lessons?: boolean;
  /** Память (флаг "memory"). По умолчанию вкл. */
  memory?: boolean;
  log?: (line: string) => void;
}

export interface TaskResult {
  id: string;
  title: string;
  /** null — проверку нечем выполнить (нет браузера). */
  ok: boolean | null;
  note: string;
  seconds: number;
  toolCalls: number;
  costUsd: number;
  interventions: Record<string, number>;
  answer: string;
  error?: string;
}

interface TaskDef {
  id: string;
  dir: string;
  title: string;
  prompt: string;
}

export function listTasks(only?: string[]): TaskDef[] {
  return readdirSync(TASKS_DIR)
    .filter((id) => existsSync(join(TASKS_DIR, id, "task.json")))
    .filter((id) => !only?.length || only.includes(id))
    .sort()
    .map((id) => {
      const def = JSON.parse(readFileSync(join(TASKS_DIR, id, "task.json"), "utf8")) as {
        title: string;
        prompt: string;
      };
      return { id, dir: join(TASKS_DIR, id), ...def };
    });
}

interface MessageLike {
  role: string;
  content?: unknown;
  customType?: string;
  display?: boolean;
  isError?: boolean;
}

function textOf(m: MessageLike): string {
  if (typeof m.content === "string") return m.content;
  if (!Array.isArray(m.content)) return "";
  return (m.content as { type: string; text?: string }[])
    .map((p) => (p.type === "text" ? (p.text ?? "") : ""))
    .join("");
}

/** Вмешательства по записям сессии (для режима без харнесса часть — просто ноль) и счётчикам харнесса. */
export function countInterventions(
  messages: MessageLike[],
  stats: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  const add = (k: string, n = 1) => {
    if (n > 0) out[k] = (out[k] ?? 0) + n;
  };
  for (const m of messages) {
    const text = textOf(m);
    if (m.role === "toolResult") {
      if (text.includes("уже был") && text.includes("Сделай другое")) add("loop");
      if (text.includes("[Процесс остановлен по таймауту")) add("timeout");
      if (/запущен[аы]? (?:через реестр харнесса|в фоне)/.test(text)) add("server");
      if (/^(?:Validation failed|Invalid arguments) for tool/.test(text)) add("validationError");
      if (text.includes("Совет из прошлых задач:")) add("lessonTip");
    }
    if (m.role === "custom" && text.includes("Совет из прошлых задач:")) add("lessonTip");
    if (m.role === "custom" && m.customType?.startsWith("prsloy-harness")) {
      const kind = m.customType.slice("prsloy-harness".length).replace(/^\./, "") || "loop";
      if (kind === "second-opinion") {
        if (m.display) add(text.startsWith("Проверила") ? "reviewPass" : "reviewFail");
      } else if (kind === "stop-gate") add(m.display ? "stopGateGaveUp" : "stopGate");
      else if (kind === "tool-leak") add(m.display ? "leakGaveUp" : "leak");
      else if (kind === "loop")
        add(text.startsWith("Ответ дважды обрезан") ? "lengthStop" : "pseudoCall");
      else add(kind);
    }
  }
  for (const [k, n] of Object.entries(stats)) if (k.startsWith("repair:")) add("repair", n);
  return out;
}

function fakeScript(
  task: TaskDef,
): (request: { messages: { role: string; content?: unknown }[] }) => ScriptedReply {
  const replies = JSON.parse(readFileSync(join(task.dir, "fake.json"), "utf8")) as ScriptedReply[];
  let next = 0;
  return (request) => {
    const last = request.messages.findLast((m) => m.role === "user");
    if (messageText(last).startsWith("Ты проверяющий"))
      return { text: '{"verdict":"PASS","items":[]}' };
    return replies[next++] ?? { text: "Готово." };
  };
}

async function runTask(task: TaskDef, opts: BenchOptions): Promise<TaskResult> {
  const work = join(opts.outDir, "work");
  mkdirSync(work, { recursive: true });
  const ws = mkdtempSync(join(work, `${task.id}-`));
  const original = join(task.dir, "workspace");
  if (existsSync(original)) cpSync(original, ws, { recursive: true });
  const agentDir = mkdtempSync(join(work, `${task.id}-agent-`));

  let server: ScriptedOpenAiServer | undefined;
  let baseUrl = opts.baseUrl;
  if (opts.fake) {
    server = new ScriptedOpenAiServer(fakeScript(task));
    await server.start();
    baseUrl = server.baseUrl;
  }
  if (!baseUrl) throw new Error("нужен --base-url или --fake");
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify(
      { providers: { [PRSLOY_PROVIDER_ID]: buildPrsloyModelsJsonProvider(baseUrl) } },
      null,
      2,
    ),
  );
  // Флаги — тем же файлом, что пишет приложение.
  const settingsPath = join(agentDir, "prsloy-harness.json");
  writeFileSync(
    settingsPath,
    JSON.stringify({ lessons: opts.lessons !== false, memory: opts.memory !== false }),
  );
  const slash = opts.model.indexOf("/");
  const model = { provider: opts.model.slice(0, slash), id: opts.model.slice(slash + 1) };

  // Как в приложении: граница записи первой, потом харнесс; «выкл» — голый Pi с тем же системным промптом.
  const extensionFactories = [
    createWriteBoundary(),
    opts.harness
      ? createPrsloyHarness({
          outputDir: join(opts.outDir, "harness"),
          learningDir: join(opts.outDir, "learning"),
          settingsPath,
        })
      : (pi: ExtensionAPI) => installReusePrompt(pi, resolveOptions({ profile: "code" })),
  ];
  let handle: ZenoRuntimeHandle | undefined;
  let asked = 0;
  const started = Date.now();
  let error: string | undefined;
  try {
    handle = await createPixRuntime({
      cwd: ws,
      agentDir,
      model,
      runtimeApiKeys: { [PRSLOY_PROVIDER_ID]: opts.key ?? "fake" },
      extensionFactories,
      persistSession: true,
      sessionDir: join(opts.outDir, "sessions", task.id),
      projectTrusted: true,
      onExtensionUiRequest: (request) => {
        if (request.method !== "select" && request.method !== "confirm") return;
        asked += 1;
        const yes = opts.allowOutside === true;
        handle?.respondExtensionUi({
          runtimeId: request.runtimeId,
          requestId: request.requestId,
          ok: true,
          value: request.method === "confirm" ? yes : yes ? ANSWER_YES : ANSWER_NO,
        });
      },
    });
    const session = handle.runtime.session;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([
      session.prompt(task.prompt).then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), opts.timeoutSec * 1000);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (timedOut) {
      error = `не уложилась в ${opts.timeoutSec} с`;
      await session.abort();
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  const session = handle?.runtime.session;
  const messages = (session?.messages ?? []) as unknown as MessageLike[];
  const interventions = countInterventions(
    messages,
    session ? harnessStats(session.sessionId) : {},
  );
  if (asked) interventions.askedOutside = asked;
  const toolCalls = messages
    .filter((m) => m.role === "assistant" && Array.isArray(m.content))
    .reduce(
      (n, m) => n + (m.content as { type: string }[]).filter((p) => p.type === "toolCall").length,
      0,
    );
  const costUsd = session?.getSessionStats().cost ?? 0;
  const answer = textOf(
    [...messages].reverse().find((m) => m.role === "assistant" && textOf(m).trim()) ?? {
      role: "x",
    },
  );
  await handle?.dispose().catch(() => undefined);
  await server?.stop();

  let ok: boolean | null = false;
  let note = "";
  try {
    const check = (await import(pathToFileURL(join(task.dir, "check.mjs")).href)) as {
      default: (input: {
        ws: string;
        original: string;
        answer: string;
      }) => Promise<{ ok: boolean | null; note: string }>;
    };
    ({ ok, note } = await check.default({ ws, original, answer }));
  } catch (e) {
    note = `проверка упала: ${e instanceof Error ? e.message : String(e)}`;
  }
  return {
    id: task.id,
    title: task.title,
    ok: error && ok === null ? false : ok,
    note,
    seconds,
    toolCalls,
    costUsd,
    interventions,
    answer: answer.slice(0, 600),
    ...(error ? { error } : {}),
  };
}

export interface BenchReport {
  meta: {
    model: string;
    harness: boolean;
    lessons: boolean;
    memory: boolean;
    fake: boolean;
    date: string;
    gateway: string;
    timeoutSec: number;
  };
  results: TaskResult[];
  totals: {
    passed: number;
    failed: number;
    skipped: number;
    seconds: number;
    toolCalls: number;
    costUsd: number;
  };
}

export async function runBench(opts: BenchOptions): Promise<BenchReport> {
  process.env.PRSLOY_PROFILE = "code";
  mkdirSync(opts.outDir, { recursive: true });
  const results: TaskResult[] = [];
  try {
    for (const task of listTasks(opts.tasks)) {
      opts.log?.(`… ${task.id}`);
      const result = await runTask(task, opts);
      results.push(result);
      opts.log?.(
        `${result.ok === true ? "✓" : result.ok === null ? "–" : "✗"} ${task.id}: ${result.note}${result.error ? ` (${result.error})` : ""}`,
      );
    }
  } finally {
    await closeSharedProxy();
  }
  const sum = (f: (r: TaskResult) => number) => results.reduce((n, r) => n + f(r), 0);
  return {
    meta: {
      model: opts.model,
      harness: opts.harness,
      lessons: opts.lessons !== false,
      memory: opts.memory !== false,
      fake: opts.fake === true,
      date: new Date().toISOString(),
      gateway: opts.fake ? "fake" : new URL(opts.baseUrl ?? "http://unknown").host,
      timeoutSec: opts.timeoutSec,
    },
    results,
    totals: {
      passed: results.filter((r) => r.ok === true).length,
      failed: results.filter((r) => r.ok === false).length,
      skipped: results.filter((r) => r.ok === null).length,
      seconds: Math.round(sum((r) => r.seconds)),
      toolCalls: sum((r) => r.toolCalls),
      costUsd: sum((r) => r.costUsd),
    },
  };
}

export function reportMarkdown(report: BenchReport): string {
  const { meta, results, totals } = report;
  const rows = results.map((r) => {
    const mark = r.ok === true ? "✓" : r.ok === null ? "—" : "✗";
    const iv = Object.entries(r.interventions)
      .map(([k, n]) => `${k} ${n}`)
      .join(", ");
    return `| ${r.id} | ${mark} ${r.note.replace(/\|/g, "/")}${r.error ? ` (${r.error})` : ""} | ${r.seconds} | ${r.toolCalls} | ${r.costUsd.toFixed(4)} | ${iv || "—"} |`;
  });
  return [
    `# Замер: ${meta.model}, харнесс ${meta.harness ? "вкл" : "выкл"}, уроки ${meta.lessons ? "вкл" : "выкл"}, память ${meta.memory ? "вкл" : "выкл"}${meta.fake ? " (фейковая модель)" : ""}`,
    "",
    `${meta.date} · шлюз ${meta.gateway} · таймаут задачи ${meta.timeoutSec} с`,
    "",
    "| Задача | Проверка | Время, с | Вызовов | $ | Вмешательства харнесса |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    `Итого: прошло ${totals.passed} из ${results.length}${totals.skipped ? `, не проверено ${totals.skipped}` : ""}; ${totals.seconds} с; вызовов ${totals.toolCalls}; $${totals.costUsd.toFixed(4)}.`,
    "",
  ].join("\n");
}
