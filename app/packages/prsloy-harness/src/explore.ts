// Разведчик (issue #47): помощник, который отвечает на вопрос по файлам проекта, ничего не меняя.
// Чужой пакет pi-subagents не берём: его профиль scout умеет bash и write, а гарантии «только чтение» в тексте
// инструкции нет (research/32). Здесь ребёнок получает ровно read/grep/find/ls в корне проекта, ограниченное
// число ходов, ответ не длиннее лимита, а его стоимость уходит в статистику сессии.
// Ключ шлюза ребёнку не передаётся: он не запускает процессов, а идёт через тот же реестр моделей Pi, что и
// проверяющий (reviewer.ts), — тем же ключом и через тот же прокси надёжности.
import {
  createReadOnlyTools,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { messageCostRub } from "./budget.ts";
import { readFlags, type ExploreMode } from "./flags.ts";
import type { ResolvedOptions } from "./options.ts";
import { recordUsage } from "./reviewer.ts";

/** Флаг `explore` объявлен в flags.ts (его читает и приложение); здесь — работа разведчика. */
export type { ExploreMode } from "./flags.ts";

/** Глубина: сколько ответов модели ребёнку разрешено до обязательного ответа. */
export type ExploreDepth = "quick" | "medium" | "thorough";
export const EXPLORE_TURNS: Record<ExploreDepth, number> = { quick: 5, medium: 10, thorough: 20 };
export const EXPLORE_DEFAULT_DEPTH: ExploreDepth = "medium";

/** Сколько знаков ответа ребёнка видит родитель. Длинный ответ — обрезка с пометкой. */
export const EXPLORE_ANSWER_LIMIT = 4_000;
/** Сколько знаков одного результата инструмента идёт ребёнку: контекст не раздуваем. */
export const EXPLORE_TOOL_OUTPUT_LIMIT = 8_000;
export const EXPLORE_MAX_TOKENS = 8_000;

/** Инструменты ребёнка: только чтение. Ни bash, ни write/edit, ни explore (рекурсии нет). */
export const EXPLORE_TOOL_NAMES: readonly string[] = ["read", "grep", "find", "ls"];

/** Начало системного промпта ребёнка: по нему стенд отличает его запросы от запросов агента (bench/lib/meter.ts). */
export const EXPLORE_MARKER = "Ты разведчик";

export const EXPLORE_SYSTEM = [
  `${EXPLORE_MARKER}. Тебе задают вопрос о файлах проекта. Отвечай, только читая: read, grep, find, ls.`,
  "Менять файлы и запускать команды нельзя — таких инструментов у тебя нет.",
  "Ищи по делу: сначала grep и find, потом read нужных мест. Целиком большие файлы не читай.",
  "В ответе — что нашёл: пути файлов, номера строк, короткие дословные цитаты. Без вступлений и без «я посмотрел».",
  `Не длиннее ${EXPLORE_ANSWER_LIMIT} знаков. Если ответа в проекте нет — скажи это одной фразой.`,
].join("\n");

/** Строка родителю в промпте: когда звать разведчика. Кладём её отдельным разделом промпта
 * (event.systemPromptOptions.sections) — promptGuidelines у инструмента, зарегистрированного
 * из расширения, до готового промпта не доходят (замер #47: 0 вхождений в запросах к шлюзу). */
export const EXPLORE_LINE =
  "Use explore for a question about this project (where something lives, how it works): it reads the code itself and returns a short answer with file paths, so you do not fill your own context with files.";

/** Ошибки ребёнка не роняют ход: они возвращаются ответом. */
export function exploreError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Complete = ExtensionContext["modelRegistry"]["complete"];
export type ExploreModel = NonNullable<ExtensionContext["model"]>;
export type ExploreMessage = Parameters<Complete>[1]["messages"][number];
export type ExploreReply = Awaited<ReturnType<Complete>>;
export type ExploreTool = ReturnType<typeof createReadOnlyTools>[number];
/** Вызов модели ребёнка: настоящий реестр Pi или подмена в тестах. */
export type ExploreComplete = (
  model: ExploreModel,
  context: Parameters<Complete>[1],
  options: { signal?: AbortSignal; maxTokens?: number },
) => Promise<ExploreReply>;

/** Инструменты ребёнка в корне проекта: из набора Pi берём только разрешённые по имени. */
export function exploreTools(cwd: string): ExploreTool[] {
  return createReadOnlyTools(cwd).filter((tool) => EXPLORE_TOOL_NAMES.includes(tool.name));
}

/** Ответ не длиннее лимита; обрезанный помечен, чтобы родитель знал, что видел не всё. */
export function clipAnswer(
  text: string,
  limit = EXPLORE_ANSWER_LIMIT,
): { text: string; clipped: boolean } {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return { text: trimmed, clipped: false };
  const mark = "\n[…обрезано: ответ длиннее лимита]";
  return {
    text: `${trimmed.slice(0, Math.max(0, limit - mark.length)).trimEnd()}${mark}`,
    clipped: true,
  };
}

/** Самая дешёвая модель списка по цене входа и выхода за миллион токенов. */
export function cheapestModel<T extends { cost?: { input?: number; output?: number } }>(
  models: readonly T[],
): T | undefined {
  let best: T | undefined;
  let bestCost = Number.POSITIVE_INFINITY;
  for (const model of models) {
    const cost = (model.cost?.input ?? 0) + (model.cost?.output ?? 0);
    if (cost < bestCost) {
      bestCost = cost;
      best = model;
    }
  }
  return best;
}

/** Модель ребёнка: `провайдер/модель` из настроек, иначе по флагу — та же или самая дешёвая того же провайдера. */
export function exploreModel(
  ctx: ExtensionContext,
  mode: ExploreMode,
  override?: string,
): ExploreModel | undefined {
  const all = ctx.modelRegistry.getAll() as ExploreModel[];
  if (override) {
    const slash = override.indexOf("/");
    if (slash <= 0) return undefined;
    return ctx.modelRegistry.find(override.slice(0, slash), override.slice(slash + 1)) as
      | ExploreModel
      | undefined;
  }
  const parent = ctx.model;
  if (!parent || mode === "off") return undefined;
  if (mode === "same") return parent;
  const same = all.filter((model) => model.provider === parent.provider);
  return cheapestModel(same) ?? parent;
}

export interface ExploreRun {
  question: string;
  depth: ExploreDepth;
  /** Корень проекта: ребёнок читает только его. */
  cwd: string;
  tools: readonly ExploreTool[];
  model: ExploreModel;
  complete: ExploreComplete;
  signal?: AbortSignal;
  maxTokens?: number;
  /** Стоимость и токены каждого ответа — в статистику сессии. */
  onUsage?: (reply: ExploreReply) => void;
}

export interface ExploreAnswer {
  answer: string;
  clipped: boolean;
  /** Сколько ответов модели было. */
  turns: number;
  toolCalls: number;
  /** Файлы, которых касались вызовы (read/grep/find). */
  files: string[];
  stoppedBy: "answer" | "depth" | "aborted" | "error";
  error?: string;
}

function textOf(reply: ExploreReply): string {
  return reply.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

function textPart(text: string): { type: "text"; text: string } {
  return { type: "text", text };
}

/** Файл, который тронул вызов: для счёта «N файлов» в карточке. */
export function callPath(
  name: string,
  args: Record<string, unknown> | undefined,
): string | undefined {
  if (!args) return undefined;
  const path = args.path ?? args.file ?? args.pattern;
  return typeof path === "string" && path.trim() ? path.trim() : undefined;
}

/** Результат ребёнку: текст в пределах лимита, ошибка — как ошибка. */
function clipToolOutput(text: string): string {
  if (text.length <= EXPLORE_TOOL_OUTPUT_LIMIT) return text;
  return `${text.slice(0, EXPLORE_TOOL_OUTPUT_LIMIT)}\n[…обрезано: результат длиннее лимита]`;
}

/**
 * Цикл разведчика: модель зовёт инструменты чтения, пока не ответит или пока не кончится глубина. На последнем
 * разрешённом ходе инструменты не передаются — ответ обязателен, лишнего вызова модели нет.
 */
export async function runExplore(input: ExploreRun): Promise<ExploreAnswer> {
  const maxTurns = EXPLORE_TURNS[input.depth] ?? EXPLORE_TURNS[EXPLORE_DEFAULT_DEPTH];
  const messages: ExploreMessage[] = [
    { role: "user", content: input.question.trim(), timestamp: Date.now() },
  ];
  const files = new Set<string>();
  let turns = 0;
  let toolCalls = 0;
  const done = (
    text: string,
    stoppedBy: ExploreAnswer["stoppedBy"],
    error?: string,
  ): ExploreAnswer => {
    const clip = clipAnswer(text);
    return {
      answer: clip.text,
      clipped: clip.clipped,
      turns,
      toolCalls,
      files: [...files],
      stoppedBy,
      ...(error ? { error } : {}),
    };
  };
  for (let turn = 0; turn < maxTurns; turn++) {
    if (input.signal?.aborted) return done("", "aborted");
    const last = turn === maxTurns - 1;
    const reply = await input.complete(
      input.model,
      {
        systemPrompt: EXPLORE_SYSTEM,
        messages,
        ...(last ? {} : { tools: [...input.tools] }),
      },
      {
        maxTokens: input.maxTokens ?? EXPLORE_MAX_TOKENS,
        ...(input.signal ? { signal: input.signal } : {}),
      },
    );
    turns += 1;
    input.onUsage?.(reply);
    if (reply.stopReason === "aborted") return done(textOf(reply), "aborted");
    if (reply.stopReason === "error")
      return done(textOf(reply), "error", reply.errorMessage ?? "модель не ответила");
    messages.push(reply);
    const calls = reply.content.filter((part) => part.type === "toolCall");
    if (calls.length === 0) return done(textOf(reply), "answer");
    for (const call of calls) {
      toolCalls += 1;
      const path = callPath(call.name, call.arguments as Record<string, unknown>);
      if (path) files.add(path);
      const tool = input.tools.find((candidate) => candidate.name === call.name);
      let content: { type: "text"; text: string }[];
      let isError = false;
      if (!tool) {
        content = [
          textPart(
            `Инструмента ${call.name} у разведчика нет: можно только ${EXPLORE_TOOL_NAMES.join(", ")}.`,
          ),
        ];
        isError = true;
      } else {
        try {
          const result = await tool.execute(
            call.id,
            call.arguments as Parameters<ExploreTool["execute"]>[1],
            input.signal,
          );
          isError = result.isError === true;
          const text = result.content
            .map((part) => (part.type === "text" ? part.text : ""))
            .filter(Boolean)
            .join("\n");
          content = [textPart(clipToolOutput(text))];
        } catch (error) {
          content = [textPart(`${call.name}: ${exploreError(error)}`)];
          isError = true;
        }
      }
      messages.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content,
        isError,
        timestamp: Date.now(),
      });
    }
  }
  // Сюда не доходят: на последнем ходе инструментов нет и модель обязана ответить. Страховка.
  return done("", "depth");
}

/** Ответ родителю: что нашёл разведчик, за сколько файлов и секунд. */
export function exploreResultText(
  answer: ExploreAnswer,
  model: ExploreModel,
  seconds: number,
): string {
  if (answer.stoppedBy === "error")
    return `Разведчик не справился (${model.provider}/${model.id}): ${answer.error ?? "ошибка модели"}`;
  if (answer.stoppedBy === "aborted") return "Разведчик остановлен.";
  if (!answer.answer) return "Разведчик ничего не нашёл по этому вопросу.";
  const head = `Разведчик (${model.provider}/${model.id}, ${answer.files.length} файлов, ${Math.round(seconds)} с) — только чтение:`;
  const tail = answer.clipped ? "\n[ответ разведчика обрезан по лимиту]" : "";
  return `${head}\n${answer.answer}${tail}`;
}

export interface ExploreOptions {
  /** Включить без флага (стенд, тесты). */
  enabled?: boolean;
  /** `провайдер/модель` вместо выбора по флагу. */
  model?: string;
  /** Подмена вызова модели (тесты). */
  complete?: ExploreComplete;
}

/**
 * Инструмент `explore` в «Коде». Флаг читается в начале каждого хода: включили или выключили в приложении —
 * инструмент появляется или уходит без перезапуска хоста.
 */
export function installExplore(
  pi: ExtensionAPI,
  opts: ResolvedOptions,
  extra: ExploreOptions = {},
): void {
  if (opts.profile !== "code") return;
  const mode = (): ExploreMode =>
    extra.enabled === true ? "same" : readFlags(opts.settingsPath).explore;
  const active = () => mode() !== "off";
  pi.on("before_agent_start", (event) => {
    const current = pi.getActiveTools();
    const want = active();
    // Подсказка «когда звать» живёт ровно столько, сколько включён инструмент: раздел промпта
    // ставим и снимаем каждый ход, иначе модель не знает про разведчика вовсе.
    if (want) event.systemPromptOptions.sections.prsloy_scout = EXPLORE_LINE;
    else delete event.systemPromptOptions.sections.prsloy_scout;
    const settled = want ? current.includes("explore") : !current.includes("explore");
    if (settled) return undefined;
    pi.setActiveTools(
      want ? [...current, "explore"] : current.filter((name) => name !== "explore"),
    );
    return undefined;
  });
  pi.registerTool({
    name: "explore",
    label: "разведчик",
    defaultActive: active(),
    description:
      "Answer a question about this project by reading its files. A separate read-only assistant (read, grep, find, ls) " +
      "looks the answer up and returns a short summary with file paths; it cannot change anything. " +
      "Use it instead of reading many files yourself when you need to know where something is or how it works.",
    promptSnippet: "Ask a read-only assistant about this project's files",
    parameters: Type.Object({
      question: Type.String({
        description:
          "What to find out, in one or two sentences, e.g. 'where is the retry budget checked?'",
      }),
      depth: Type.Optional(
        Type.Union([Type.Literal("quick"), Type.Literal("medium"), Type.Literal("thorough")], {
          description: "How far to look: quick (5 steps), medium (10, default), thorough (20)",
        }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const current = mode();
      if (current === "off")
        return {
          content: [textPart("Разведчик выключен в настройках харнесса (флаг explore).")],
          details: { skipped: true },
          isError: true,
        };
      const model = exploreModel(ctx, current, extra.model);
      if (!model)
        return {
          content: [textPart("Разведчику не нашлось модели: нет каталога моделей сессии.")],
          details: { skipped: true },
          isError: true,
        };
      const started = Date.now();
      const complete: ExploreComplete =
        extra.complete ??
        ((target, context, options) => ctx.modelRegistry.complete(target, context, options));
      let answer: ExploreAnswer;
      try {
        answer = await runExplore({
          question: params.question,
          depth: (params.depth as ExploreDepth | undefined) ?? EXPLORE_DEFAULT_DEPTH,
          cwd: ctx.cwd,
          tools: exploreTools(ctx.cwd),
          model,
          complete,
          ...(signal ? { signal } : {}),
          onUsage: (reply) =>
            recordUsage(
              ctx,
              model,
              reply.usage,
              messageCostRub(reply.usage, model.cost),
              "prsloy_explore",
              "Разведчик",
            ),
        });
      } catch (error) {
        return {
          content: [textPart(`Разведчик не справился: ${exploreError(error)}`)],
          details: { question: params.question, model: `${model.provider}/${model.id}` },
          isError: true,
        };
      }
      const seconds = (Date.now() - started) / 1000;
      return {
        content: [textPart(exploreResultText(answer, model, seconds))],
        details: {
          question: params.question,
          depth: params.depth ?? EXPLORE_DEFAULT_DEPTH,
          model: `${model.provider}/${model.id}`,
          files: answer.files.length,
          seconds: Math.round(seconds),
          turns: answer.turns,
          toolCalls: answer.toolCalls,
          clipped: answer.clipped,
          stoppedBy: answer.stoppedBy,
        },
        isError: answer.stoppedBy === "error",
      };
    },
  });
}
