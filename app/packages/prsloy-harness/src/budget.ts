// Практика 5 (PLAN-alpha §3): лимит шагов и денег на задачу.
// Источник: ADR-3 (research/00-synthesis.md), E8 (research/REPORT-2026-10-22*.md).
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResolvedOptions } from "./options.ts";
import { appendText, keepStructured, showCard } from "./text.ts";
import { recordEvent } from "./learning-log.ts";

interface UsageLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
}

interface ModelCostLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** Цена ответа: из usage.cost.total, иначе по таблице цен модели ($ за миллион токенов). */
export function messageCostUsd(
  usage: UsageLike | undefined,
  cost: ModelCostLike | undefined,
): number {
  if (!usage) return 0;
  const reported = usage.cost?.total;
  if (typeof reported === "number" && reported > 0) return reported;
  if (!cost) return 0;
  return (
    ((usage.input ?? 0) * (cost.input ?? 0) +
      (usage.output ?? 0) * (cost.output ?? 0) +
      (usage.cacheRead ?? 0) * (cost.cacheRead ?? 0) +
      (usage.cacheWrite ?? 0) * (cost.cacheWrite ?? 0)) /
    1_000_000
  );
}

export interface BudgetState {
  toolCalls: number;
  costUsd: number;
  warned: boolean;
  exhausted: "calls" | "money" | undefined;
  /** Вызовы, заблокированные после исчерпания. */
  blockedAfterStop: number;
  filesChanged: Set<string>;
  commands: number;
}

function freshState(): BudgetState {
  return {
    toolCalls: 0,
    costUsd: 0,
    warned: false,
    exhausted: undefined,
    blockedAfterStop: 0,
    filesChanged: new Set(),
    commands: 0,
  };
}

/** «1 шаг», «3 шага», «150 шагов». */
function steps(n: number): string {
  const tens = n % 100;
  const ones = n % 10;
  const word =
    tens >= 11 && tens <= 14
      ? "шагов"
      : ones === 1
        ? "шаг"
        : ones >= 2 && ones <= 4
          ? "шага"
          : "шагов";
  return `${n} ${word}`;
}

/**
 * Итог для человека: без «тулов», «вызовов» и долларов (цифры — в details карточки). Что успел и как продолжить.
 */
export function budgetSummary(state: BudgetState, opts: ResolvedOptions): string {
  const reason =
    state.exhausted === "calls"
      ? `на одну задачу у меня ${steps(opts.maxToolCalls)}, и они закончились`
      : "на эту задачу ушла вся отведённая на неё сумма";
  const files = [...state.filesChanged];
  const done = files.length
    ? `Что успел: изменил ${files.slice(0, 5).join(", ")}${files.length > 5 ? ` и ещё ${files.length - 5}` : ""}.`
    : "Файлы я не менял.";
  return `Я остановился: ${reason}. ${done} Если нужно доделать, напишите «продолжай».`;
}

/** Модели: лимит исчерпан, тулы больше не выполняются — коротко подвести итог для человека. */
function stopReason(state: BudgetState): string {
  const what =
    state.exhausted === "money" ? "Лимит денег на задачу исчерпан" : "Лимит шагов задачи исчерпан";
  return `${what}: инструменты больше не выполняются, не вызывай их. Напиши пользователю по-русски 2–4 строки без технических слов: что уже сделано и что осталось.`;
}

export interface BudgetHandle {
  state: () => BudgetState;
  installWarning: () => void;
  /** Доля бюджета, уже потраченная (наибольшая из «вызовы» и «деньги»). */
  ratio: () => number;
  /** Расход вне ответов модели агента (ревью второй моделью) — в стоимость хода. */
  spend: (usd: number) => void;
}

export function installBudget(pi: ExtensionAPI, opts: ResolvedOptions): BudgetHandle {
  let state = freshState();

  const ratio = () =>
    Math.max(state.toolCalls / opts.maxToolCalls, state.costUsd / opts.maxCostUsd);

  pi.on("before_agent_start", (event) => {
    if (event.messageType === "user") state = freshState();
  });

  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant") return;
    state.costUsd += messageCostUsd(message.usage, ctx.model?.cost);
    if (!state.exhausted && state.costUsd >= opts.maxCostUsd) state.exhausted = "money";
  });

  pi.on("tool_call", (event, ctx: ExtensionContext) => {
    if (event.parentToolCallId) return undefined;
    if (!state.exhausted && state.toolCalls >= opts.maxToolCalls) state.exhausted = "calls";
    if (state.exhausted) {
      state.blockedAfterStop += 1;
      // Первый раз даём модели ход на итог; если она снова зовёт тулы — завершаем.
      if (state.blockedAfterStop > 3) ctx.abort();
      if (state.blockedAfterStop === 1)
        recordEvent(ctx, { kind: "budget.stop", sig: `budget:${state.exhausted}` });
      return { block: true, reason: stopReason(state), terminate: state.blockedAfterStop > 1 };
    }
    state.toolCalls += 1;
    if (event.toolName === "bash" || event.toolName === "powershell") state.commands += 1;
    if (
      (event.toolName === "edit" || event.toolName === "write") &&
      typeof event.input.path === "string"
    ) {
      state.filesChanged.add(event.input.path);
    }
    return undefined;
  });

  pi.on("agent_before_settle", async () => {
    if (!state.exhausted || state.blockedAfterStop === 0) return undefined;
    const summary = budgetSummary(state, opts);
    state.blockedAfterStop = 0;
    const data = { ...state, filesChanged: [...state.filesChanged] };
    await showCard(pi, "prsloy-harness.budget", summary, data);
    return undefined;
  });

  /**
   * Предупреждение о бюджете дописывается отдельным обработчиком, который ставится после обрезки вывода:
   * иначе read сверх 30 КБ отрезал бы строку, а флаг «предупредили» уже стоял бы.
   */
  const installWarning = () => {
    pi.on("tool_result", (event, ctx) => {
      if (event.parentToolCallId || state.warned || ratio() < opts.budgetWarnRatio)
        return undefined;
      state.warned = true;
      recordEvent(ctx, { kind: "budget.warn" });
      const note =
        `[Задача израсходовала ${Math.round(ratio() * 100)}% лимита (шагов ${state.toolCalls} из ${opts.maxToolCalls}). ` +
        "Заканчивай главное, без лишних шагов.]";
      return { content: appendText(event.content, note), ...keepStructured(event) };
    });
  };

  const spend = (usd: number) => {
    state.costUsd += usd;
    if (!state.exhausted && state.costUsd >= opts.maxCostUsd) state.exhausted = "money";
  };

  return { state: () => state, installWarning, ratio, spend };
}
