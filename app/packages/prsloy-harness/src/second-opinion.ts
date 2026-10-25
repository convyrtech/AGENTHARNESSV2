// Практика 9 (PLAN-alpha §3) и ADR-7 (research/00-synthesis.md): писатель и проверяющий — из разных семей.
// В «Дизайне» это second_opinion.py (PLAN-alpha §3, строка 9: ADR-7, D7, E8p).
// Здесь — дифф хода во вкладке «Код»: одна дешёвая модель другой семьи, строгий JSON, и замечание засчитывается,
// только если его цитата `evidence` действительно есть в диффе (проверяем кодом). Без цитаты — PASS: выдуманные
// замечания хуже, чем никаких.
import { headTail } from "./text.ts";

/**
 * Кто проверяет кого: семья писателя → проверяющие других семей по предпочтению (префиксы id моделей шлюза PRSLOY).
 * Каталог шлюза (core, `/v1/models`) бывает неполным: берётся первый, кто в нём есть.
 */
export const REVIEWER_PREFERENCES: readonly (readonly [RegExp, readonly string[]])[] = [
  [/qwen/i, ["deepseek", "kimi", "claude-opus"]],
  [/opus|claude/i, ["kimi", "deepseek", "qwen"]],
  [/deepseek/i, ["kimi", "qwen", "claude-opus"]],
  [/kimi/i, ["deepseek", "qwen", "claude-opus"]],
];

/** Проверяющие для модели-писателя по порядку предпочтения; пусто — семьи нет в списке, ревью не делаем. */
export function reviewersFor(writerModelId: string): readonly string[] {
  return REVIEWER_PREFERENCES.find(([family]) => family.test(writerModelId))?.[1] ?? [];
}

/** Первый по предпочтению префикс (без учёта каталога). */
export function reviewerFor(writerModelId: string): string | undefined {
  return reviewersFor(writerModelId)[0];
}

/** Модель с id, равным префиксу или начинающимся с него (`deepseek-v4.1-flash` → `deepseek-v4.1-flash-1017`). */
export function pickModel<T extends { id: string }>(
  models: readonly T[],
  prefix: string,
): T | undefined {
  return models.find((m) => m.id === prefix) ?? models.find((m) => m.id.startsWith(prefix));
}

/** Сколько строк диффа поменялось (+/-, без заголовков файлов). */
export function changedLines(patch: string): number {
  let n = 0;
  for (const line of patch.split("\n"))
    if (/^[+-]/.test(line) && !/^(\+\+\+|---)( |$)/.test(line)) n += 1;
  return n;
}

interface FileChunk {
  file: string;
  text: string;
}

function splitFiles(patch: string): FileChunk[] {
  const chunks: FileChunk[] = [];
  for (const part of patch.split(/^(?=diff --git )/m)) {
    if (!part.trim()) continue;
    const head = /^diff --git a\/(.+?) b\/(.+)$/m.exec(part);
    chunks.push({ file: head?.[2] ?? head?.[1] ?? "", text: part });
  }
  return chunks;
}

/**
 * Дифф для проверяющего в пределах `limit` символов: у каждого файла — начало и конец, если весь не влез.
 * Цитаты проверяем по этому же тексту: модель могла сослаться только на то, что видела.
 */
export function clipDiff(patch: string, limit = 24_000): string {
  if (patch.length <= limit) return patch;
  const chunks = splitFiles(patch);
  // Запас на пометку «пропущено» у каждого файла.
  const per = Math.max(1_500, Math.floor(limit / Math.max(1, chunks.length)) - 120);
  let out = "";
  for (const chunk of chunks) {
    const piece = chunk.text.length <= per ? chunk.text : `${headTail(chunk.text, per)}\n`;
    if (out.length + piece.length > limit) {
      out += `\n[ещё файлов не показано: ${chunks.length - chunks.indexOf(chunk)}]\n`;
      break;
    }
    out += piece;
  }
  return out;
}

export interface ReviewInput {
  task: string;
  diff: string;
  checks: string;
}

export function reviewPrompt(input: ReviewInput): string {
  return [
    "Ты проверяющий. Другая модель выполнила задачу пользователя и изменила файлы. Найди в изменениях настоящие",
    "ошибки: код не сделает то, что просили; упадёт; сломает то, что работало; потеряет данные; явная дыра в",
    "безопасности. Стиль, имена, «можно лучше» и пожелания — не ошибки, их не пиши.",
    "",
    "Ответ — только JSON, без пояснений вокруг:",
    '{"verdict":"PASS"|"FAIL","items":[{"file":"путь","line":12,"problem":"что не так, по-русски, одной фразой",',
    '"evidence":"точная строка из диффа, где ошибка"}]}',
    "",
    "evidence — дословная копия одной строки из диффа ниже (без +/- в начале). Замечание без такой цитаты не",
    'засчитывается. Ошибок нет — {"verdict":"PASS","items":[]}.',
    "",
    "Задача пользователя:",
    "<<<",
    input.task.trim() || "(не указана)",
    ">>>",
    "",
    "Проверки проекта после изменений:",
    input.checks.trim() || "(нет)",
    "",
    "Дифф:",
    "<<<",
    input.diff,
    ">>>",
  ].join("\n");
}

export interface ReviewItem {
  file: string;
  line?: number;
  problem: string;
  evidence: string;
}

export interface ReviewVerdict {
  verdict: "PASS" | "FAIL";
  /** Замечания с подтверждённой цитатой. */
  items: ReviewItem[];
  /** Сколько замечаний отброшено: цитаты нет в диффе. */
  rejected: number;
  /** Ответ не разобран (не JSON, нет verdict). Тогда verdict = PASS, а гейт молчит. */
  invalid?: boolean;
}

function normalize(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}

/** Строки диффа без маркера +/-/пробел и с одинаковыми пробелами — с ними сравниваем цитату. */
function diffLines(diff: string): string[] {
  return diff
    .split("\n")
    .filter((l) => !/^(diff --git|index |\+\+\+ |--- |@@ )/.test(l))
    .map((l) => normalize(/^[+\- ]/.test(l) ? l.slice(1) : l))
    .filter(Boolean);
}

/** Цитата есть в диффе: строка диффа содержит её (подстрока), и в ней хоть что-то кроме скобок. */
export function evidenceInDiff(evidence: string, diff: string, file?: string): boolean {
  const quote = normalize(evidence.replace(/^[+-]\s?/, "").replace(/^`+|`+$/g, ""));
  if (quote.replace(/[\s{}()[\];,.'"`]/g, "").length < 4) return false;
  const chunks = splitFiles(diff);
  const own = file ? chunks.filter((c) => c.file === file || c.file.endsWith(`/${file}`)) : [];
  const scope = own.length > 0 ? own.map((c) => c.text).join("\n") : diff;
  return diffLines(scope).some((line) => line.includes(quote));
}

/** JSON из ответа модели: ```json-блок или первый `{` … последний `}`. */
function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
  for (const candidate of [fenced, text]) {
    if (!candidate) continue;
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      // следующий вариант
    }
  }
  return undefined;
}

/** Разбор ответа проверяющего. FAIL — только если осталось хоть одно замечание с цитатой из диффа. */
export function parseVerdict(text: string, diff: string): ReviewVerdict {
  const parsed = extractJson(text) as { verdict?: unknown; items?: unknown } | undefined;
  if (!parsed || typeof parsed !== "object" || typeof parsed.verdict !== "string")
    return { verdict: "PASS", items: [], rejected: 0, invalid: true };
  const raw = Array.isArray(parsed.items) ? (parsed.items as Record<string, unknown>[]) : [];
  const items: ReviewItem[] = [];
  let rejected = 0;
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const evidence = typeof item.evidence === "string" ? item.evidence : "";
    const file = typeof item.file === "string" ? item.file.replace(/^[ab]\//, "") : "";
    const problem = typeof item.problem === "string" ? item.problem.trim() : "";
    if (!problem || !evidenceInDiff(evidence, diff, file || undefined)) {
      rejected += 1;
      continue;
    }
    const line = typeof item.line === "number" && item.line > 0 ? item.line : undefined;
    items.push({ file, problem, evidence: evidence.trim(), ...(line ? { line } : {}) });
  }
  return { verdict: items.length > 0 ? "FAIL" : "PASS", items, rejected };
}

/** «1 замечание», «2 замечания», «5 замечаний». */
export function remarks(n: number): string {
  const tens = n % 100;
  const ones = n % 10;
  const word =
    tens >= 11 && tens <= 14
      ? "замечаний"
      : ones === 1
        ? "замечание"
        : ones >= 2 && ones <= 4
          ? "замечания"
          : "замечаний";
  return `${n} ${word}`;
}

export const REVIEW_PASS_CARD = "Проверила вторая модель: замечаний нет";

export function reviewFailCard(count: number): string {
  return `Вторая модель нашла ${remarks(count)} — исправляю`;
}

export function reviewPushback(items: ReviewItem[]): string {
  const list = items
    .map((item, i) => {
      const where = item.file ? `${item.file}${item.line ? `:${item.line}` : ""} — ` : "";
      return `${i + 1}. ${where}${item.problem}\n   Строка: \`${item.evidence}\``;
    })
    .join("\n");
  return (
    `Вторая модель другого семейства проверила твои изменения и нашла:\n${list}\n` +
    "Проверь каждое замечание по коду. Верное — исправь и проверь снова; неверное — не трогай и коротко скажи " +
    "пользователю, почему."
  );
}
