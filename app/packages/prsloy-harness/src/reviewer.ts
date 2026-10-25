// Вызов проверяющего: модель другой семьи у того же провайдера, через реестр моделей Pi — значит, тем же ключом и
// через тот же прокси надёжности (он переопределяет baseUrl провайдера). Цена ответа уходит в статистику сессии
// записью usage (так Pi учитывает свои внеочередные вызовы), поэтому она видна в стоимости хода.
import { existsSync, readFileSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { messageCostUsd } from "./budget.ts";
import { pickModel, reviewerFor } from "./second-opinion.ts";

export interface ReviewReply {
  text: string;
  model: string;
  costUsd: number;
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
  const prefix = reviewerFor(writer.id);
  if (!prefix) return undefined;
  const candidate = pickModel(
    all.filter((m) => m.provider === writer.provider),
    prefix,
  );
  // Своей семье не доверяем (ADR-7): если пара случайно указала на ту же модель — ревью нет.
  return candidate && candidate.id !== writer.id ? candidate : undefined;
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
      const costUsd = messageCostUsd(reply.usage, model.cost);
      recordUsage(ctx, model, reply.usage, costUsd);
      const text = reply.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("")
        .trim();
      const failed = reply.stopReason === "error" || reply.stopReason === "aborted";
      return {
        text,
        model: `${model.provider}/${model.id}`,
        costUsd,
        ...(failed ? { error: reply.errorMessage ?? reply.stopReason } : {}),
      };
    } catch (error) {
      return {
        text: "",
        model: `${model.provider}/${model.id}`,
        costUsd: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

type Usage = Parameters<typeof messageCostUsd>[0];

/** Запись usage в сессию: getSessionStats() Pi суммирует её в стоимость, которую показывает приложение. */
function recordUsage(ctx: ExtensionContext, model: Model, usage: Usage, costUsd: number): void {
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
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...usage.cost, total: costUsd };
  try {
    manager.appendUsage(
      "prsloy_second_opinion",
      model.provider,
      model.id,
      { ...usage, cost },
      "Проверка второй моделью",
    );
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
