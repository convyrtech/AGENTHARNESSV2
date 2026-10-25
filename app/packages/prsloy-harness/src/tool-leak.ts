// Утечка разметки вызова инструмента в ответ. DeepSeek через a6 иногда отдаёт вызов текстом: stopReason `stop`,
// toolCall нет, `text` дословно повторяет `thinking`, а в конце висят закрывающие теги `</｜DSML｜invoke>`.
// Pi считает ход законченным — задача брошена посреди, пользователь видит простыню рассуждений.
// Факт: A/B дирижёра на шаге 7 «Дизайна» (deepseek-v4.1-flash-1017), 3 сессии из 22; следы — в логах E6/E7.
// Харнесс не даёт такому ходу закончиться: возвращает модель повторить вызов (≤ 2 раз за сообщение
// пользователя, отдельно от стоп-гейта), а из контекста модели убирает дубль рассуждения и теги.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { showCard } from "./text.ts";
import { recordEvent } from "./learning-log.ts";
import { intervene } from "./lessons.ts";

/** Служебные токены вызова инструмента. В обычном тексте их не бывает, поэтому код-блоки не исключаем. */
export const TOOL_MARKUP: readonly RegExp[] = [
  /｜\s*DSML\s*｜/, // DeepSeek V4: <｜DSML｜invoke>, </｜DSML｜ parameter>
  /<｜\s*tool▁(?:calls?▁begin|calls?▁end|call▁begin|call▁end|sep|outputs?▁begin)\s*｜>/, // DeepSeek V3
  /<\/?tool_call>/, // Qwen, Hermes
  /<\|\s*tool_(?:calls_section_begin|calls_section_end|call_begin|call_end|call_argument_begin)\s*\|>/, // Kimi
];

/** Дубль рассуждения в ответе считается утечкой, если он не короче этого. */
export const DUPLICATE_THINKING_MIN = 1000;

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

export type LeakKind = "markup" | "duplicate-thinking";

/** Что в финальном тексте ассистента выдаёт сорванный вызов инструмента. */
export function detectToolLeak(text: string, thinking: string): LeakKind | undefined {
  // Разметка внутри ``` или `…` — это объяснение формата, а не сорванный вызов.
  const prose = text.replace(/```[\s\S]*?(?:```|$)/g, " ").replace(/`[^`\n]*`/g, " ");
  if (TOOL_MARKUP.some((re) => re.test(prose))) return "markup";
  const body = normalize(text);
  if (body.length > DUPLICATE_THINKING_MIN && body === normalize(thinking))
    return "duplicate-thinking";
  return undefined;
}

/** Строки с разметкой вызова — вон; остальной текст как был. */
export function stripToolMarkup(text: string): string {
  return text
    .split("\n")
    .filter((line) => !TOOL_MARKUP.some((re) => re.test(line)))
    .join("\n")
    .trimEnd();
}

export const TOOL_LEAK_NOTE =
  "Твой последний вызов инструмента не дошёл: он пришёл текстом. Повтори его обычным вызовом инструмента, без рассуждений в ответе.";

export const TOOL_LEAK_GAVE_UP =
  "Модель сбилась, нажмите «Повторить» или переключитесь на «Качественнее».";

export const MAX_LEAK_RETRIES = 2;

interface Part {
  type: string;
  text?: string;
  thinking?: string;
}

interface AssistantLike {
  role: string;
  stopReason?: string;
  content?: Part[];
}

function partsOf(message: AssistantLike): { text: string; thinking: string; calls: boolean } {
  const content = Array.isArray(message.content) ? message.content : [];
  return {
    text: content.map((p) => (p.type === "text" ? (p.text ?? "") : "")).join("\n"),
    thinking: content.map((p) => (p.type === "thinking" ? (p.thinking ?? "") : "")).join("\n"),
    calls: content.some((p) => p.type === "toolCall"),
  };
}

/** Ответ без утечки для контекста модели: без дубля рассуждения и строк разметки. undefined — менять нечего. */
export function cleanLeakedMessage<T extends AssistantLike>(message: T): T | undefined {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
  const { text, thinking } = partsOf(message);
  const leak = detectToolLeak(text, thinking);
  if (!leak) return undefined;
  const duplicate = normalize(stripToolMarkup(text)) === normalize(thinking);
  const content = message.content
    .map((part) => {
      if (part.type !== "text") return part;
      if (duplicate) return undefined;
      return { ...part, text: stripToolMarkup(part.text ?? "") };
    })
    .filter((part): part is Part => part !== undefined && !(part.type === "text" && !part.text));
  return { ...message, content };
}

export function installToolLeak(pi: ExtensionAPI): void {
  let retries = 0;
  let gaveUp = false;
  let last: AssistantLike | undefined;

  pi.on("before_agent_start", (event) => {
    if (event.messageType !== "user") return;
    retries = 0;
    gaveUp = false;
    last = undefined;
  });

  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") last = event.message as unknown as AssistantLike;
  });

  // Модели не показываем её же простыню: на каждом запросе дубль рассуждения и теги вырезаются.
  pi.on("context", (event) => {
    let changed = false;
    const messages = event.messages.map((message) => {
      const clean = cleanLeakedMessage(message as unknown as AssistantLike);
      if (!clean) return message;
      changed = true;
      return clean as unknown as typeof message;
    });
    return changed ? { messages } : undefined;
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    if (event.outcome !== "completed" || gaveUp || !last) return undefined;
    if (last.stopReason !== "stop") return undefined;
    const { text, thinking, calls } = partsOf(last);
    if (calls || !detectToolLeak(text, thinking)) return undefined;
    last = undefined;
    if (retries >= MAX_LEAK_RETRIES) {
      gaveUp = true;
      recordEvent(ctx, { kind: "leak.gaveup" });
      await showCard(pi, "prsloy-harness.tool-leak", TOOL_LEAK_GAVE_UP);
      return undefined;
    }
    retries += 1;
    const tip = intervene(ctx, { kind: "leak", sig: `leak:${detectToolLeak(text, thinking)}` });
    return {
      entries: [
        ...event.entries,
        {
          type: "custom_message",
          customType: "prsloy-harness.tool-leak",
          content: `${TOOL_LEAK_NOTE}${tip}`,
          display: false,
        },
      ],
      continue: true,
    };
  });
}
