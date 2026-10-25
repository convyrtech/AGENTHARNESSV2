// Практика 5 (PLAN-alpha §3): детектор петель, псевдовызовов текстом и вызовов из ответа, обрезанного по length.
// Источник: ADR-3 (research/00-synthesis.md), research/06-harness2.md (анти-псевдовызов 60 → 100),
// research/08-practitioners-research.md (Cline: нативные вызовы, DeepSeek V4 Flash 13.4% → 1.3%).
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { detectToolLeak } from "./tool-leak.ts";
import type { ResolvedOptions } from "./options.ts";
import { contentText, stableStringify } from "./text.ts";
import { callSignature, recordEvent } from "./learning-log.ts";

interface CallRecord {
  /** Номер «эпохи» файлов: после успешной правки старые счётчики не действуют. */
  epoch: number;
  count: number;
  lastResult: string | undefined;
  /** Сколько раз подряд вызов вернул тот же результат. */
  sameResults: number;
}

/** Разметка вызовов, которую модели пишут текстом вместо настоящего tool call. */
const PSEUDO_MARKERS: RegExp[] = [
  /<\/?tool_call>/i, // Hermes, Qwen
  /<function=[\w.-]+>/i, // Llama / Qwen-coder
  /<(?:antml:)?function_calls>|<(?:antml:)?invoke\s+name=/i, // XML в стиле Anthropic
  /<\|tool_calls?_(?:section_)?begin\|>/i, // Kimi
  /<｜tool▁calls?▁begin｜>/, // DeepSeek
  /\[TOOL_CALLS\]/, // Mistral
];

/** Код в ответе — это объяснение, а не вызов: блоки ``` и `inline` не проверяем. */
function stripCode(text: string): string {
  return text.replace(/```[\s\S]*?(?:```|$)/g, " ").replace(/`[^`\n]*`/g, " ");
}

/** Pi дописывает к обрезанному выводу уникальный путь временного файла — для сравнения его убираем. */
const PI_FULL_OUTPUT = /\[Showing [^\]]*Full output: [^\]]*\]|полностью: [^\]]*\]/g;

const MUTATING_TOOLS = new Set(["edit", "write"]);

export function detectPseudoToolCall(
  raw: string,
  toolNames: readonly string[],
): string | undefined {
  const text = stripCode(raw);
  for (const marker of PSEUDO_MARKERS) {
    const match = marker.exec(text);
    if (match) return match[0];
  }
  if (toolNames.length > 0) {
    const names = toolNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const json = new RegExp(
      `\\{\\s*"(?:name|tool|function)"\\s*:\\s*"(?:${names})"\\s*,\\s*"(?:arguments|parameters|args|input)"\\s*:`,
    );
    const match = json.exec(text);
    if (match) return match[0];
    // Вызов в блоке ```json — частый псевдовызов дешёвых моделей. Но блок внутри длинного объяснения —
    // это пример, а не вызов: считаем, только если прозы вокруг почти нет.
    const fenced = /```[\w-]*\s*([\s\S]*?)```/.exec(raw);
    const prose = text.replace(/\s+/g, " ").trim();
    if (fenced?.[1] && prose.length <= 200) {
      const inFence = json.exec(fenced[1]);
      if (inFence) return inFence[0];
    }
  }
  return undefined;
}

function plural(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  return mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? "раза" : "раз";
}

function hash(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

export const PSEUDO_CALL_NOTE =
  "Ты написал вызов тула текстом — он НЕ выполнен. Вызывай тулы только настоящим вызовом (tool call), без разметки в тексте. Если тул не нужен — просто ответь.";

export const LENGTH_NOTE =
  "Ответ дважды обрезан по длине, вызовы тулов из него не выполнены. Делай меньше за один вызов: создай файл коротким каркасом через write, потом дописывай частями через edit.";

export function installLoopDetector(pi: ExtensionAPI, opts: ResolvedOptions): void {
  let calls = new Map<string, CallRecord>();
  let epoch = 0;
  const keyById = new Map<string, string>();
  let pseudoNudges = 0;
  let lengthStops = 0;
  let lastAssistantStop: string | undefined;

  pi.on("before_agent_start", (event) => {
    if (event.messageType !== "user") return;
    // Новая задача пользователя: повтор той же команды по его просьбе — не петля.
    calls = new Map();
    keyById.clear();
    pseudoNudges = 0;
    lengthStops = 0;
  });

  pi.on("message_end", (event) => {
    const message = event.message;
    if (message.role === "assistant") lastAssistantStop = message.stopReason;
  });

  pi.on("tool_call", (event, ctx) => {
    if (event.parentToolCallId) return undefined;
    // Pi 1.4 сам не исполняет вызовы из ответа, обрезанного по length (agent-loop.js
    // failToolCallsFromTruncatedMessage). Здесь — страховка на случай, если путь изменится.
    if (lastAssistantStop === "length") {
      recordEvent(ctx, { kind: "length.block", tool: event.toolName });
      return {
        block: true,
        reason:
          "Ответ обрезан по длине (length): аргументы могли оборваться, вызов не выполнен. Повтори его целиком и короче.",
      };
    }
    const key = `${event.toolName}\u0000${stableStringify(event.input)}`;
    keyById.set(event.toolCallId, key);
    let record = calls.get(key);
    if (!record || record.epoch !== epoch) {
      // Файлы с тех пор менялись: повтор того же вызова — проверка правки, а не петля.
      record = { epoch, count: 0, lastResult: undefined, sameResults: 0 };
    }
    record.count += 1;
    calls.set(key, record);
    // Петля — только когда исполненный вызов уже дважды дал один и тот же результат.
    // Заблокированные вызовы в tool_result не попадают, поэтому count растёт, а sameResults — нет.
    const looping = record.sameResults >= opts.loopWarnAt - 2;
    if (looping && record.count >= opts.loopAbortAt) {
      keyById.delete(event.toolCallId);
      if (record.count > opts.loopAbortAt) ctx.abort();
      recordEvent(ctx, {
        kind: "loop.stop",
        tool: event.toolName,
        sig: callSignature(event.toolName, event.input),
      });
      return {
        block: true,
        terminate: true,
        reason: `Вызов ${event.toolName} повторён ${record.count} раз с тем же результатом. Задача остановлена, чтобы не тратить бюджет. Напиши пользователю коротко, что сделано и где застрял.`,
      };
    }
    if (looping && record.count >= opts.loopWarnAt) {
      keyById.delete(event.toolCallId);
      recordEvent(ctx, {
        kind: "loop.warn",
        tool: event.toolName,
        sig: callSignature(event.toolName, event.input),
      });
      return {
        block: true,
        reason: `Этот вызов уже был ${record.count - 1} ${plural(record.count - 1)} с тем же результатом. Сделай другое: перечитай условие задачи, посмотри файл или лог, который ещё не смотрел, или смени подход. Повтор не поможет.`,
      };
    }
    return undefined;
  });

  pi.on("tool_result", (event) => {
    if (MUTATING_TOOLS.has(event.toolName) && !event.isError) epoch += 1;
    const key = keyById.get(event.toolCallId);
    if (!key) return undefined;
    keyById.delete(event.toolCallId);
    const record = calls.get(key);
    if (!record) return undefined;
    const result = hash(
      `${event.isError ? "E" : "O"}${contentText(event.content).replace(PI_FULL_OUTPUT, "")}`,
    );
    if (record.lastResult === result) record.sameResults += 1;
    else {
      // Результат изменился (например, после правки файла) — это уже не петля.
      record.lastResult = result;
      record.sameResults = 0;
      record.count = 1;
    }
    return undefined;
  });

  pi.on("turn_end", (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant") return undefined;
    const hasCalls = message.content.some((part) => part.type === "toolCall");
    if (message.stopReason === "length" && hasCalls) {
      lengthStops += 1;
      if (lengthStops === 2) {
        recordEvent(ctx, { kind: "length.stop" });
        // Pi заменяет список записей тем, что вернул обработчик (runner.emitBoundary): чужие сохраняем.
        return {
          entries: [
            ...event.entries,
            {
              type: "custom_message",
              customType: "prsloy-harness",
              content: LENGTH_NOTE,
              display: false,
            },
          ],
        };
      }
      return undefined;
    }
    if (hasCalls || message.stopReason !== "stop") return undefined;
    const text = message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
    const thinking = message.content
      .map((part) => (part.type === "thinking" ? part.thinking : ""))
      .join("\n");
    // Служебные токены и дубль рассуждения — забота tool-leak.ts (на agent_before_settle, свой лимит).
    if (detectToolLeak(text, thinking)) return undefined;
    const toolNames = pi.getActiveTools();
    const marker = detectPseudoToolCall(text, toolNames);
    if (!marker || pseudoNudges >= 2) return undefined;
    pseudoNudges += 1;
    recordEvent(ctx, { kind: "pseudo.call" });
    return {
      entries: [
        ...event.entries,
        {
          type: "custom_message",
          customType: "prsloy-harness",
          content: PSEUDO_CALL_NOTE,
          display: false,
        },
      ],
      continue: true,
    };
  });
}
