// Практика 12 (часть, PLAN-alpha §3) и ADR-13: детерминированный слой безопасности первым.
// Ключи из результатов тулов не уходят модели (и дальше — поставщику) даже если агент прочитал .env.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { contentText, withText } from "./text.ts";
import { recordEvent } from "./learning-log.ts";

interface SecretRule {
  kind: string;
  pattern: RegExp;
  /** Номер группы, которую оставить как есть (префикс вида `KEY=`). */
  keep?: number;
}

const RULES: SecretRule[] = [
  {
    kind: "приватный ключ",
    pattern:
      // Конец блока может быть отрезан (head, обрезка вывода) — тогда вырезаем до конца текста.
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
  },
  // Цифра обязательна: у ключей она есть всегда, у CSS-классов вроде sk-folding-cube — нет.
  { kind: "sk-ключ", pattern: /\bsk-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}/g },
  { kind: "Stripe-ключ", pattern: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{20,}/g },
  {
    kind: "GitHub-токен",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g,
  },
  { kind: "AWS-ключ", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  {
    kind: "AWS-секрет",
    pattern: /(aws_secret_access_key["']?\s*[=:]\s*["']?)[A-Za-z0-9/+=]{40}/gi,
    keep: 1,
  },
  { kind: "Slack-токен", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: "Google-ключ", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  // Ключи поиска (issue #23): Brave «BSA…», Яндекс Cloud API-ключ «AQVN…» и IAM-токен «t1.…», Jina «jina_…»,
  // Firecrawl «fc-<32 hex>». Ключ Exa — UUID, а UUID в коде всюду: только рядом с exa / x-api-key.
  { kind: "ключ Brave", pattern: /\bBSA[A-Za-z0-9_-]{20,}/g },
  { kind: "ключ Яндекс Cloud", pattern: /\bAQVN[A-Za-z0-9_-]{30,}/g },
  { kind: "IAM-токен Яндекса", pattern: /\bt1\.[A-Za-z0-9_-]{40,}\.[A-Za-z0-9_-]{40,}/g },
  { kind: "ключ Jina", pattern: /\bjina_[A-Za-z0-9]{30,}/g },
  { kind: "ключ Firecrawl", pattern: /\bfc-[a-f0-9]{32}\b/g },
  {
    kind: "ключ Exa",
    pattern:
      /((?:exa|x-api-key)[^\n]{0,40}?)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    keep: 1,
  },
  // Токен бота от @BotFather: id бота, двоеточие, 35 знаков (research/19; кнопка-пример «Бот для Telegram»).
  { kind: "токен Telegram-бота", pattern: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g },
];

export interface ScrubResult {
  text: string;
  count: number;
  kinds: string[];
}

// Значения, которые пользователь ввёл в окно ключа (request_secret): прячутся дословно, где бы ни всплыли.
const KNOWN_VALUES = new Map<string, string>();
const KNOWN_MAX = 200;

/** Добавить введённый ключ в список чистки. Короче 6 знаков не берём: заденет обычный текст. */
export function rememberSecretValue(value: string, name: string): void {
  if (value.length < 6) return;
  KNOWN_VALUES.delete(value);
  KNOWN_VALUES.set(value, `ключ ${name}`);
  while (KNOWN_VALUES.size > KNOWN_MAX) KNOWN_VALUES.delete(KNOWN_VALUES.keys().next().value!);
}

export function scrubSecrets(text: string): ScrubResult {
  let count = 0;
  const kinds = new Set<string>();
  let out = text;
  for (const [value, kind] of KNOWN_VALUES) {
    if (!out.includes(value)) continue;
    const parts = out.split(value);
    count += parts.length - 1;
    kinds.add(kind);
    out = parts.join(`[СКРЫТО: ${kind}]`);
  }
  for (const rule of RULES) {
    out = out.replace(rule.pattern, (_whole: string, group?: unknown) => {
      count += 1;
      kinds.add(rule.kind);
      const kept = rule.keep !== undefined && typeof group === "string" ? group : "";
      return `${kept}[СКРЫТО: ${rule.kind}]`;
    });
  }
  return { text: out, count, kinds: [...kinds] };
}

function scrubJson(value: unknown): { value: unknown; count: number } {
  if (typeof value === "string") {
    const r = scrubSecrets(value);
    return { value: r.text, count: r.count };
  }
  if (Array.isArray(value)) {
    let count = 0;
    const out = value.map((item) => {
      const r = scrubJson(item);
      count += r.count;
      return r.value;
    });
    return { value: out, count };
  }
  if (value && typeof value === "object") {
    let count = 0;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const r = scrubJson(item);
      count += r.count;
      out[key] = r.value;
    }
    return { value: out, count };
  }
  return { value, count: 0 };
}

export function scrubNote(count: number, kinds: string[]): string {
  return `[Скрыто секретов: ${count} (${kinds.join(", ")}). Модели они не показываются. Строки с «[СКРЫТО…]» не переписывай и не вставляй в файлы — в настоящем файле там ключ; правь вокруг них через edit. Если ключ нужен программе — бери его из переменной окружения.]`;
}

export const PLACEHOLDER_WRITE_NOTE =
  "В новом тексте есть «[СКРЫТО: …]» — это заглушка, которую видишь только ты; в настоящем файле на этом месте ключ. Запись не выполнена. Не трогай строки с ключами: правь остальное через edit с oldText без этих строк.";

/** Регистрировать последним: tool_result-обработчики идут цепочкой, этот видит итоговый текст. */
export function installSecretScrub(pi: ExtensionAPI): void {
  // Модель видит файл с заглушками; если она перепишет его как видит, ключ пользователя сотрётся.
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
    const input = event.input as { content?: unknown; edits?: unknown };
    const texts = [
      input.content,
      ...(Array.isArray(input.edits)
        ? input.edits.map((e: { newText?: unknown }) => e?.newText)
        : []),
    ];
    if (texts.some((t) => typeof t === "string" && t.includes("[СКРЫТО: "))) {
      recordEvent(ctx, { kind: "secret.placeholder", tool: event.toolName });
      return { block: true, reason: PLACEHOLDER_WRITE_NOTE };
    }
    return undefined;
  });

  pi.on("tool_result", (event) => {
    const text = contentText(event.content);
    const scrubbed = scrubSecrets(text);
    const structured =
      event.structuredContent === undefined ? undefined : scrubJson(event.structuredContent);
    if (scrubbed.count === 0 && !structured?.count) return undefined;
    const note = scrubbed.count > 0 ? `\n\n${scrubNote(scrubbed.count, scrubbed.kinds)}` : "";
    return {
      content: withText(event.content, `${scrubbed.text}${note}`),
      ...(structured === undefined
        ? {}
        : { structuredContent: structured.value as typeof event.structuredContent }),
    };
  });
}
