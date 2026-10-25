// Практика 5 (PLAN-alpha §3): лимит шагов и денег на задачу.
// Источник: ADR-3 (research/00-synthesis.md), E8 (research/REPORT-2026-10-22*.md).
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResolvedOptions } from "./options.ts";
import { appendText, keepStructured } from "./text.ts";

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

function money(usd: number): string {
  return `$${usd.toFixed(usd < 0.1 ? 3 : 2)}`;
}

export function budgetSummary(state: BudgetState, opts: ResolvedOptions): string {
  const reason =
    state.exhausted === "calls"
      ? `лимит вызовов тулов (${opts.maxToolCalls})`
      : `лимит денег на задачу (${money(opts.maxCostUsd)})`;
  const files = [...state.filesChanged];
  const done = files.length
    ? `изменены файлы: ${files.slice(0, 10).join(", ")}${files.length > 10 ? ` и ещё ${files.length - 10}` : ""}`
    : "файлы не менялись";
  return `Задача остановлена: исчерпан ${reason}. Вызовов: ${state.toolCalls}, потрачено ${money(state.costUsd)}. Сделано: ${done}; команд запущено: ${state.commands}.`;
}

const STOP_REASON =
  "Бюджет задачи исчерпан, тулы больше не выполняются. Не вызывай тулы. Напиши пользователю по-русски 2–4 строки: что уже сделано и что осталось сделать.";

export function installBudget(
  pi: ExtensionAPI,
  opts: ResolvedOptions,
): { state: () => BudgetState; installWarning: () => void } {
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
      return { block: true, reason: STOP_REASON, terminate: state.blockedAfterStop > 1 };
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

  pi.on("agent_before_settle", (event) => {
    if (!state.exhausted || state.blockedAfterStop === 0) return undefined;
    const summary = budgetSummary(state, opts);
    state.blockedAfterStop = 0;
    const data = { ...state, filesChanged: [...state.filesChanged] };
    return {
      // Pi заменяет список записей тем, что вернул обработчик: чужие записи сохраняем.
      entries: [
        ...event.entries,
        { type: "custom", customType: "prsloy-harness.budget", data },
        {
          type: "custom_message",
          customType: "prsloy-harness.budget",
          content: summary,
          display: true,
        },
      ],
    };
  });

  /**
   * Предупреждение о бюджете дописывается отдельным обработчиком, который ставится после обрезки вывода:
   * иначе read сверх 30 КБ отрезал бы строку, а флаг «предупредили» уже стоял бы.
   */
  const installWarning = () => {
    pi.on("tool_result", (event) => {
      if (event.parentToolCallId || state.warned || ratio() < opts.budgetWarnRatio)
        return undefined;
      state.warned = true;
      const note =
        `[Бюджет задачи: ${Math.round(ratio() * 100)}% — вызовов ${state.toolCalls}/${opts.maxToolCalls}, ` +
        `${money(state.costUsd)} из ${money(opts.maxCostUsd)}. Заканчивай главное, без лишних шагов.]`;
      return { content: appendText(event.content, note), ...keepStructured(event) };
    });
  };

  return { state: () => state, installWarning };
}
