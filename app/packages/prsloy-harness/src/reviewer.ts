// Вызов проверяющего: модель другой семьи у того же провайдера, через реестр моделей Pi — значит, тем же ключом и
// через тот же прокси надёжности (он переопределяет baseUrl провайдера). Цена ответа уходит в статистику сессии
// записью usage (так Pi учитывает свои внеочередные вызовы), поэтому она видна в стоимости хода.
import { existsSync, readFileSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { messageCostRub } from "./budget.ts";
import { pickModel, reviewersFor } from "./second-opinion.ts";

export interface ReviewReply {
  text: string;
  model: string;
  costRub: number;
  error?: string;
}

/** undefined — ревью не делаем (нет пары, нет модели проверяющего). */
export type Reviewer = (prompt: string, ctx: ExtensionContext) => Promise<ReviewReply | undefined>;

export interface ReviewerOptions {
  /** `провайдер/модель` вместо пары по семье (тесты, e2e с фейковой моделью). */
  model?: string;
  timeoutMs?: number;
  maxTokens?: number;
}

type Model = NonNullable<ExtensionContext["model"]>;

export function resolveReviewerModel(
  ctx: ExtensionContext,
  override: string | undefined,
): Model | undefined {
  const all = ctx.modelRegistry.getAll() as Model[];
  if (override) {
    const slash = override.indexOf("/");
    if (slash <= 0) return undefined;
    return ctx.modelRegistry.find(override.slice(0, slash), override.slice(slash + 1)) as
      | Model
      | undefined;
  }
  const writer = ctx.model;
  if (!writer) return undefined;
  // Каталог сессии (тот, что видит Pi): у core в models.json только модели, которые есть на шлюзе.
  const same = all.filter((m) => m.provider === writer.provider);
  for (const prefix of reviewersFor(writer.id)) {
    const candidate = pickModel(same, prefix);
    // Своей семье не доверяем (ADR-7): ту же модель не берём, идём к следующему по списку.
    if (candidate && candidate.id !== writer.id) return candidate;
  }
  return undefined;
}

export function modelReviewer(options: ReviewerOptions = {}): Reviewer {
  return async (prompt, ctx) => {
    const model = resolveReviewerModel(ctx, options.model);
    if (!model) return undefined;
    const signals = [AbortSignal.timeout(options.timeoutMs ?? 120_000)];
    if (ctx.signal) signals.push(ctx.signal);
    try {
      const reply = await ctx.modelRegistry.complete(
        model,
        { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
        { signal: AbortSignal.any(signals), maxTokens: options.maxTokens ?? 16_000 },
      );
      const costRub = messageCostRub(reply.usage, model.cost);
      recordUsage(ctx, model, reply.usage, costRub);
      const text = reply.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("")
        .trim();
      const failed = reply.stopReason === "error" || reply.stopReason === "aborted";
      return {
        text,
        model: `${model.provider}/${model.id}`,
        costRub,
        ...(failed ? { error: reply.errorMessage ?? reply.stopReason } : {}),
      };
    } catch (error) {
      return {
        text: "",
        model: `${model.provider}/${model.id}`,
        costRub: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

type Usage = Parameters<typeof messageCostRub>[0];

/**
 * Запись usage в сессию: getSessionStats() Pi суммирует её в стоимость, которую показывает приложение.
 * kind — метка в статистике (`prsloy_second_opinion`, `prsloy_explore`), note — что это было.
 */
export function recordUsage(
  ctx: ExtensionContext,
  model: Model,
  usage: Usage,
  costRub: number,
  kind = "prsloy_second_opinion",
  note = "Проверка второй моделью",
): void {
  if (!usage) return;
  const manager = ctx.sessionManager as unknown as {
    appendUsage?: (
      kind: string,
      provider: string,
      model: string,
      usage: unknown,
      note?: string,
    ) => void;
  };
  if (typeof manager.appendUsage !== "function") return;
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...usage.cost, total: costRub };
  try {
    manager.appendUsage(kind, model.provider, model.id, { ...usage, cost }, note);
  } catch {
    // статистика — не повод ронять ход
  }
}

/**
 * Флаг «Проверка второй моделью» (по умолчанию вкл). Читается на каждом ходе: приложение пишет
 * `{"secondOpinion": false}` в `prsloy-harness.json` папки агента, перезапуск хоста не нужен.
 * PRSLOY_SECOND_OPINION=0 выключает совсем.
 */
export function secondOpinionFlag(settingsPath: string | undefined): () => boolean {
  return () => {
    if (process.env.PRSLOY_SECOND_OPINION === "0") return false;
    if (!settingsPath || !existsSync(settingsPath)) return true;
    try {
      const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as { secondOpinion?: unknown };
      return parsed.secondOpinion !== false;
    } catch {
      return true;
    }
  };
}
