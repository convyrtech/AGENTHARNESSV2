// Практика 12 (часть, PLAN-alpha §3) и ADR-13: детерминированный слой безопасности первым.
// Ключи из результатов тулов не уходят модели (и дальше — поставщику) даже если агент прочитал .env.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { contentText, withText } from "./text.ts";

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
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g,
  },
  { kind: "sk-ключ", pattern: /\bsk-(?:proj-|ant-|or-v1-|live-|test-)?[A-Za-z0-9_-]{20,}/g },
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
];

export interface ScrubResult {
  text: string;
  count: number;
  kinds: string[];
}

export function scrubSecrets(text: string): ScrubResult {
  let count = 0;
  const kinds = new Set<string>();
  let out = text;
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
  return `[Скрыто секретов: ${count} (${kinds.join(", ")}). Модели они не показываются. Если ключ нужен программе — бери его из переменной окружения, не вставляй в код.]`;
}

/** Регистрировать последним: tool_result-обработчики идут цепочкой, этот видит итоговый текст. */
export function installSecretScrub(pi: ExtensionAPI): void {
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
