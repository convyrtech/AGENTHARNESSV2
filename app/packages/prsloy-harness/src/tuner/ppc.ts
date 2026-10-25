// Оффлайн-улучшатель обвязки (#33): Propose–Probe–Compose по образцу google-research/harness2 (Apache-2.0,
// commit 1cfe254; промпты — prompts.ts, tripwire'ы — leaks.ts). Один раунд на train-задачах разбиения:
//
//   база ×k  →  редакторы INV и DOM ×k  →  валидатор (1 повтор с ошибками, потом откат к базе)
//   →  пробы кандидатов (по одному прогону)  →  композитор (MERGE / ADOPT / KEEP_BASE)
//   →  финальный прогон  →  рефлектор (таблица правок, ≤1 урок или NO_ENTRY)  →  предложение человеку.
//
// Модели видят только улики: просьбу, стенограммы, файлы агента и деревья обвязки (context.ts). Исход check.mjs
// считает только этот скрипт и пишет в RESULT.md — в контекст моделей он не попадает. Оценка на test — тоже здесь.
// Результат — предложение (PROPOSAL.md и папка обвязки): в приложение его переносит человек.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createPixRuntime, type ZenoRuntimeHandle } from "../../../agent-runtime/src/index.ts";
import {
  ANSWER_NO,
  createWriteBoundary,
} from "../../../../apps/desktop/src/agent-host/write-boundary.ts";
import {
  buildPrsloyModelsJsonProvider,
  PRSLOY_PROVIDER_ID,
} from "../../../../apps/desktop/src/shared/prsloy-config.ts";
import { type BenchReport, listTasks, runBench } from "../../bench/run.ts";
import {
  messageText,
  type Script,
  ScriptedOpenAiServer,
} from "../../test/scripted-openai-server.ts";
import { buildContext, type Rollout, rolloutsOf } from "./context.ts";
import { checkFingerprints, GRADER_VERDICT_MARKERS } from "./leaks.ts";
import { composerPrompt, type Dimension, editorPrompt, reflectorPrompt } from "./prompts.ts";
import { assertTrainOnly, type Split } from "./split.ts";
import {
  baseTree,
  benchOptionsFor,
  diffTrees,
  type HarnessTree,
  readTree,
  validateTree,
  writeTree,
} from "./tree.ts";

/** Инструменты редактора: чтение и правка файлов, без shell (shell обошёл бы границу записи). */
export const TUNER_TOOLS = ["read", "write", "edit", "ls", "grep", "find"];

export interface PpcOptions {
  /** Модель агента на стенде (`провайдер/модель`); обвязка подбирается под неё. */
  model: string;
  /** Модель редакторов, композитора и рефлектора; по умолчанию та же. */
  tunerModel?: string;
  baseUrl?: string;
  /** Ключ шлюза: только из окружения, в файлы не пишется. */
  key?: string;
  /** Фейковые модели: стенд — заготовки задач, редакторы — сценарии ниже (CI, без ключа). */
  fake?: boolean;
  split: Split;
  /** Базовых прогонов и кандидатов на измерение (agg-k). */
  k: number;
  outDir: string;
  /** Секунд на задачу стенда. */
  timeoutSec: number;
  /** Секунд на сессию редактора / композитора / рефлектора. */
  sessionTimeoutSec: number;
  /** Оценить базу и итог на test (только этим скриптом). По умолчанию да. */
  test?: boolean;
  log?: (line: string) => void;
}

export interface CandidateResult {
  label: string;
  dim: Dimension | "compose";
  /** valid — прошло валидатор; retried — со второй попытки; fallback — откат к базе. */
  status: "valid" | "retried" | "fallback";
  errors: string[];
  notes: string;
  changes: ReturnType<typeof diffTrees>;
}

export interface PpcResult {
  outDir: string;
  candidates: CandidateResult[];
  composed: CandidateResult;
  /** experience — блок `<experience>` рефлектора или NO_ENTRY. */
  reflection: { edits: string; experience: string };
  /** Сколько train-задач прошло check.mjs: подпись прогона → число. Только для человека. */
  train: Record<string, { passed: number; of: number }>;
  test?: { base: BenchReport["totals"]; composed: BenchReport["totals"] };
  costUsd: number;
}

interface Turn {
  reply: string;
  costUsd: number;
  error?: string;
}

interface TunerSession {
  prompt(text: string): Promise<Turn>;
  /** Закрыть; вернуть пути инструментов вне папки роли и папки улик (пусто — роль читала только улики). */
  close(): Promise<string[]>;
}

/**
 * Пути из вызовов инструментов роли, которые выходят за `roots`. Граница записи держит только запись, а чтение
 * открыто: check.mjs стенда лежит на диске, и `read` или `grep` до него дотянется. Такую роль не слушаем.
 */
export function outsidePaths(
  messages: readonly unknown[],
  cwd: string,
  roots: readonly string[],
): string[] {
  const out: string[] = [];
  for (const m of messages as { role?: string; content?: unknown }[]) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const part of m.content as { type?: string; arguments?: { path?: unknown } }[]) {
      if (part.type !== "toolCall" || typeof part.arguments?.path !== "string") continue;
      const p = resolve(cwd, part.arguments.path);
      const inside = roots.some((r) => {
        const rel = relative(resolve(r), p);
        return !rel.startsWith("..") && !isAbsolute(rel);
      });
      if (!inside) out.push(p);
    }
  }
  return [...new Set(out)];
}

/** Последний текст ассистента в сессии Pi. */
function lastAssistantText(messages: readonly unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown };
    if (m.role !== "assistant") continue;
    const text = messageText(m as Parameters<typeof messageText>[0]);
    if (text.trim()) return text;
  }
  return "";
}

/**
 * Сессия Pi для роли улучшателя: cwd — папка, которую роль правит; всё остальное (контекст) — только чтение:
 * граница записи спрашивает про любой путь вне cwd и временных папок, а мы всегда отвечаем «Нет».
 */
async function tunerSession(
  opts: PpcOptions,
  role: string,
  cwd: string,
  script: Script | undefined,
  seen: string[],
  contextDir: string,
): Promise<TunerSession> {
  const agentDir = join(opts.outDir, "tuner", role);
  mkdirSync(agentDir, { recursive: true });
  let server: ScriptedOpenAiServer | undefined;
  let baseUrl = opts.baseUrl;
  if (opts.fake) {
    if (!script) throw new Error(`нет фейкового сценария для ${role}`);
    server = new ScriptedOpenAiServer(script);
    await server.start();
    baseUrl = server.baseUrl;
  }
  if (!baseUrl) throw new Error("нужен --base-url или --fake");
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({ providers: { [PRSLOY_PROVIDER_ID]: buildPrsloyModelsJsonProvider(baseUrl) } }),
  );
  const name = opts.tunerModel ?? opts.model;
  const slash = name.indexOf("/");
  let handle: ZenoRuntimeHandle | undefined;
  handle = await createPixRuntime({
    cwd,
    agentDir,
    model: { provider: name.slice(0, slash), id: name.slice(slash + 1) },
    runtimeApiKeys: { [PRSLOY_PROVIDER_ID]: opts.key ?? "fake" },
    extensionFactories: [createWriteBoundary({ agentDir })],
    tools: TUNER_TOOLS,
    persistSession: true,
    sessionDir: join(agentDir, "sessions"),
    projectTrusted: true,
    onExtensionUiRequest: (request) => {
      if (request.method !== "select" && request.method !== "confirm") return;
      handle?.respondExtensionUi({
        runtimeId: request.runtimeId,
        requestId: request.requestId,
        ok: true,
        value: request.method === "confirm" ? false : ANSWER_NO,
      });
    },
  });
  const session = handle.runtime.session;
  return {
    async prompt(text) {
      const before = session.getSessionStats().cost;
      let timer: NodeJS.Timeout | undefined;
      let error: string | undefined;
      try {
        const timedOut = await Promise.race([
          session.prompt(text).then(() => false),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(true), opts.sessionTimeoutSec * 1000);
          }),
        ]);
        if (timedOut) {
          error = `не уложилась в ${opts.sessionTimeoutSec} с`;
          await session.abort();
        }
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      } finally {
        if (timer) clearTimeout(timer);
      }
      return {
        reply: lastAssistantText(session.messages as unknown as unknown[]),
        costUsd: session.getSessionStats().cost - before,
        ...(error ? { error } : {}),
      };
    },
    async close() {
      if (server) {
        // Всё, что ушло фейковой модели, — для проверки «ответ проверки не дошёл до модели».
        // Улики доходят до модели только результатами инструментов; промпты роли — наш текст.
        for (const r of server.requests)
          for (const m of r.messages) if (m.role === "tool") seen.push(JSON.stringify(m.content));
        await server.stop();
      }
      const outside = outsidePaths(session.messages as unknown as unknown[], cwd, [
        cwd,
        contextDir,
      ]);
      await handle?.dispose().catch(() => undefined);
      return outside;
    },
  };
}

const block = (text: string, tag: string) =>
  new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text)?.[1]?.trim();

function fixPrompt(errors: string[]): string {
  return [
    "The harness folder does not validate. Fix exactly these problems in place, change nothing else, and reply with your `<notes>` again:",
    ...errors.map((e) => `- ${e}`),
  ].join("\n");
}

/**
 * Роль, которая правит копию обвязки: промпт, проверка валидатором, одна попытка исправить с ошибками,
 * иначе — откат к базе (кандидат = база, помечен fallback).
 */
async function editHarness(
  opts: PpcOptions,
  label: string,
  dim: Dimension | "compose",
  base: HarnessTree,
  contextDir: string,
  prompt: string,
  script: Script | undefined,
  seen: string[],
  cost: { usd: number },
): Promise<{ tree: HarnessTree; result: CandidateResult }> {
  const root = join(opts.outDir, "candidates", label);
  const harness = join(root, "harness");
  writeTree(harness, base);
  const hash = treeHash(contextDir);
  const session = await tunerSession(opts, label, harness, script, seen, contextDir);
  let status: CandidateResult["status"] = "valid";
  let errors: string[] = [];
  let notes = "";
  try {
    const first = await session.prompt(prompt);
    cost.usd += first.costUsd;
    notes = block(first.reply, "notes") ?? first.reply;
    errors = first.error ? [first.error] : validateTree(readTree(harness));
    if (errors.length && !first.error) {
      opts.log?.(`${label}: ${errors.length} ошибок валидатора, вторая попытка`);
      const second = await session.prompt(fixPrompt(errors));
      cost.usd += second.costUsd;
      notes = block(second.reply, "notes") ?? notes;
      errors = second.error ? [second.error] : validateTree(readTree(harness));
      status = "retried";
    }
  } finally {
    const outside = await session.close();
    if (outside.length) errors = [`читал вне улик: ${outside.slice(0, 5).join(", ")}`];
  }
  assertUnchanged(contextDir, hash, label);
  if (errors.length) {
    opts.log?.(`${label}: откат к базе (${errors[0]})`);
    status = "fallback";
    writeTree(harness, base);
  }
  writeFileSync(join(root, "notes.md"), `${notes}\n`);
  if (errors.length) writeFileSync(join(root, "errors.md"), `${errors.join("\n")}\n`);
  const tree = readTree(harness);
  return {
    tree,
    result: { label, dim, status, errors, notes, changes: diffTrees(base, tree) },
  };
}

function passedOf(report: BenchReport): { passed: number; of: number } {
  return { passed: report.totals.passed, of: report.results.length };
}

/** Прогон стенда с деревом обвязки. Отчёт — только в `<out>/reports` (вне любого контекста моделей). */
async function probe(
  opts: PpcOptions,
  label: string,
  tree: HarnessTree,
  tasks: readonly string[],
): Promise<{ report: BenchReport; rollouts: Rollout[] }> {
  const outDir = join(opts.outDir, "rollouts", label);
  opts.log?.(`… стенд: ${label} (${tasks.length} задач)`);
  const report = await runBench({
    harness: true,
    model: opts.model,
    ...(opts.fake ? { fake: true } : { baseUrl: opts.baseUrl! }),
    ...(opts.key && !opts.fake ? { key: opts.key } : {}),
    tasks: [...tasks],
    suite: "casual",
    outDir,
    timeoutSec: opts.timeoutSec,
    ...benchOptionsFor(tree, join(opts.outDir, "trees", label)),
  });
  mkdirSync(join(opts.outDir, "reports"), { recursive: true });
  writeFileSync(
    join(opts.outDir, "reports", `${label}.json`),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  return { report, rollouts: rolloutsOf(outDir, tasks, label) };
}

/** Отпечаток папки контекста: роль улучшателя читает её, но не меняет (граница записи — первая защита). */
export function treeHash(dir: string): string {
  const h = createHash("sha256");
  const tree = readTree(dir);
  for (const path of Object.keys(tree).sort()) h.update(`${path}\0${tree[path]}\0`);
  return h.digest("hex");
}

function assertUnchanged(dir: string, hash: string, role: string): void {
  if (treeHash(dir) !== hash)
    throw new Error(`${role} изменил папку улик ${dir}: контекст только для чтения`);
}

/** Отказ, если до фейковой модели дошли метки вердикта или строки check.mjs (проверка на самой границе). */
export function assertModelSawNoGrader(
  seen: readonly string[],
  fingerprints: readonly string[],
): void {
  for (const body of seen) {
    const marker = GRADER_VERDICT_MARKERS.find((m) =>
      body.includes(JSON.stringify(m).slice(1, -1)),
    );
    const line = fingerprints.find((f) => body.includes(JSON.stringify(f).slice(1, -1)));
    if (marker || line)
      throw new Error(`до модели улучшателя дошёл ответ проверки: ${marker ?? line}`);
  }
}

function gitDiff(cwd: string, a: string, b: string): string {
  const r = spawnSync("git", ["diff", "--no-index", "--no-color", "--", a, b], {
    cwd,
    encoding: "utf8",
  });
  return r.status === 0 || r.status === 1 ? r.stdout : "(git недоступен — сравни папки сам)";
}

export interface FakeScripts {
  editor: (dim: Dimension, label: string) => Script;
  composer: (base: HarnessTree, candidates: Readonly<Record<string, HarnessTree>>) => Script;
  reflector: Script;
}

/** Один раунд PPC. Бросает ошибку при утечке (tripwire) — это не повод ослаблять проверку. */
export async function runPpc(opts: PpcOptions, fake?: FakeScripts): Promise<PpcResult> {
  if (opts.fake && !fake) throw new Error("--fake без сценариев");
  if (existsSync(join(opts.outDir, "context")))
    throw new Error(`${opts.outDir} уже использована: раунд пишется в новую папку`);
  mkdirSync(opts.outDir, { recursive: true });
  const k = Math.max(1, Math.floor(opts.k));
  const train = opts.split.train;
  assertTrainOnly(opts.split, train);
  const all = listTasks(undefined, "casual", false);
  const trainDefs = all.filter((t) => train.includes(t.id));
  if (trainDefs.length !== train.length)
    throw new Error(`в разбиении есть задачи не из казуального набора: ${train.join(", ")}`);
  const requests = Object.fromEntries(trainDefs.map((t) => [t.id, t.prompts]));
  const originals = Object.fromEntries(trainDefs.map((t) => [t.id, t.workspace]));
  // Строки проверок всех задач (и test тоже): ни одна не должна дойти до модели.
  const checkFiles = all.map((t) => join(t.dir, "check.mjs")).filter((f) => existsSync(f));
  const fingerprints = checkFingerprints(checkFiles);
  const seen: string[] = [];
  const cost = { usd: 0 };
  const passed: PpcResult["train"] = {};
  const ctx = (name: string) => join(opts.outDir, "context", name);

  // 1. База ×k.
  const base = baseTree(opts.model);
  writeTree(join(opts.outDir, "base", "harness"), base);
  const baseRollouts: Rollout[] = [];
  for (let i = 1; i <= k; i++) {
    const { report, rollouts } = await probe(opts, `base-${i}`, base, train);
    passed[`base-${i}`] = passedOf(report);
    cost.usd += report.totals.costUsd;
    baseRollouts.push(...rollouts);
  }

  // 2. Редакторы INV и DOM ×k по одному контексту (только база).
  const editCtx = buildContext({
    dir: ctx("edit"),
    requests,
    originals,
    base,
    rollouts: baseRollouts,
    checkFiles,
    fingerprints,
  });
  const trees: Record<string, HarnessTree> = {};
  const notes: Record<string, string> = {};
  const candidates: CandidateResult[] = [];
  for (const dim of ["INV", "DOM"] as const) {
    for (let i = 1; i <= k; i++) {
      const label = `${dim}-${i}`;
      opts.log?.(`… редактор ${label}`);
      const { tree, result } = await editHarness(
        opts,
        label,
        dim,
        base,
        editCtx,
        editorPrompt(dim, editCtx, k),
        fake?.editor(dim, label),
        seen,
        cost,
      );
      trees[label] = tree;
      notes[label] = result.notes;
      candidates.push(result);
    }
  }

  // 3. Пробы: каждый кандидат — один прогон.
  const candidateRollouts: Rollout[] = [];
  for (const [label, tree] of Object.entries(trees)) {
    const { report, rollouts } = await probe(opts, label, tree, train);
    passed[label] = passedOf(report);
    cost.usd += report.totals.costUsd;
    candidateRollouts.push(...rollouts);
  }

  // 4. Композитор.
  const composeCtx = buildContext({
    dir: ctx("compose"),
    requests,
    originals,
    base,
    rollouts: [...baseRollouts, ...candidateRollouts],
    candidates: trees,
    notes,
    checkFiles,
    fingerprints,
  });
  opts.log?.("… композитор");
  const { tree: composedTree, result: composed } = await editHarness(
    opts,
    "composed",
    "compose",
    base,
    composeCtx,
    composerPrompt(composeCtx, k),
    fake?.composer(base, trees),
    seen,
    cost,
  );

  // 5. Финальный прогон итоговой обвязки на train — улика для рефлектора.
  const final = await probe(opts, "final-1", composedTree, train);
  passed["final-1"] = passedOf(final.report);
  cost.usd += final.report.totals.costUsd;

  // 6. Рефлектор: вся запись раунда, итог — как ещё один кандидат.
  const reflectCtx = buildContext({
    dir: ctx("reflect"),
    requests,
    originals,
    base,
    rollouts: [...baseRollouts, ...candidateRollouts, ...final.rollouts],
    candidates: { ...trees, composed: composedTree },
    notes: { ...notes, composed: composed.notes },
    checkFiles,
    fingerprints,
  });
  opts.log?.("… рефлектор");
  const reflectDir = join(opts.outDir, "reflector");
  mkdirSync(reflectDir, { recursive: true });
  const reflectHash = treeHash(reflectCtx);
  const reflector = await tunerSession(
    opts,
    "reflector",
    reflectDir,
    fake?.reflector,
    seen,
    reflectCtx,
  );
  let reflection: PpcResult["reflection"] = { edits: "", experience: "NO_ENTRY" };
  try {
    const turn = await reflector.prompt(reflectorPrompt(reflectCtx));
    cost.usd += turn.costUsd;
    reflection = {
      edits: block(turn.reply, "edits") ?? "",
      experience: block(turn.reply, "experience") ?? "NO_ENTRY",
    };
    writeFileSync(join(opts.outDir, "REFLECTION.md"), `${turn.reply}\n`);
  } finally {
    const outside = await reflector.close();
    if (outside.length) {
      opts.log?.(`рефлектор читал вне улик (${outside[0]}): его запись отброшена`);
      reflection = { edits: "", experience: "NO_ENTRY" };
      writeFileSync(
        join(opts.outDir, "REFLECTION.md"),
        `Отброшено: читал вне улик — ${outside.join(", ")}\n`,
      );
    }
  }
  assertUnchanged(reflectCtx, reflectHash, "reflector");

  if (opts.fake) assertModelSawNoGrader(seen, fingerprints);

  // 7. Оценка на test — только здесь, моделям не показывается.
  let test: PpcResult["test"];
  if (opts.test !== false && opts.split.test.length) {
    const casual = new Set(all.map((t) => t.id));
    const testTasks = opts.split.test.filter((t) => casual.has(t));
    const b = await probe(opts, "test-base", base, testTasks);
    const c = await probe(opts, "test-composed", composedTree, testTasks);
    cost.usd += b.report.totals.costUsd + c.report.totals.costUsd;
    test = { base: b.report.totals, composed: c.report.totals };
  }

  const result: PpcResult = {
    outDir: opts.outDir,
    candidates,
    composed,
    reflection,
    train: passed,
    ...(test ? { test } : {}),
    costUsd: cost.usd,
  };
  writeFileSync(join(opts.outDir, "RESULT.json"), `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(
    join(opts.outDir, "PROPOSAL.md"),
    proposalMarkdown(
      opts,
      result,
      gitDiff(opts.outDir, "base/harness", "candidates/composed/harness"),
    ),
  );
  return result;
}

function proposalMarkdown(opts: PpcOptions, r: PpcResult, diff: string): string {
  const row = (c: CandidateResult) =>
    `| ${c.label} | ${c.status} | ${c.changes.map((x) => `${x.kind} ${x.path}`).join(", ") || "—"} |`;
  const t = r.test;
  return [
    `# Предложение улучшателя (#33): ${opts.model}`,
    "",
    `Разбиение: ${opts.split.rule} (решено ${opts.split.decided}). Train: ${opts.split.train.join(", ")}. k = ${opts.k}.${opts.fake ? " Фейковые модели." : ""}`,
    "",
    "Это предложение, не изменение: обвязка лежит в `candidates/composed/harness/`, в пакет её переносит человек",
    "(lessons/code.json, skills/, MODEL_DELTAS в code-prompt.ts).",
    "",
    "## Кандидаты",
    "",
    "| Кандидат | Валидатор | Правки |",
    "|---|---|---|",
    ...r.candidates.map(row),
    row(r.composed),
    "",
    "## check.mjs на train (только для человека)",
    "",
    ...Object.entries(r.train).map(([label, p]) => `- ${label}: ${p.passed}/${p.of}`),
    "",
    "## check.mjs на test",
    "",
    t
      ? `- база: прошло ${t.base.passed}, не прошло ${t.base.failed}, неожиданных исходов ${t.base.unexpected}\n- итог: прошло ${t.composed.passed}, не прошло ${t.composed.failed}, неожиданных исходов ${t.composed.unexpected}`
      : "- не оценивалось",
    "",
    "## Заметки композитора",
    "",
    r.composed.notes || "—",
    "",
    "## Рефлектор: урок",
    "",
    r.reflection.experience,
    "",
    `Стоимость раунда: $${r.costUsd.toFixed(4)}.`,
    "",
    "## Diff",
    "",
    "```diff",
    diff.trim() || "(без изменений — KEEP_BASE)",
    "```",
    "",
  ].join("\n");
}
