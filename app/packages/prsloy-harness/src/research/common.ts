// Общее для поставщиков поиска: ошибка с кодом и чистка полей выдачи. Отдельно от search.ts, чтобы бесплатный
// поиск (free.ts) и поиск модели (model-search.ts) не тянули search.ts по кругу.

export type SearchErrorCode = "no_key" | "auth" | "limit" | "network" | "format" | "no_channel";

export class SearchError extends Error {
  readonly code: SearchErrorCode;
  constructor(code: SearchErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export function clean(text: unknown, max = 400): string {
  return (typeof text === "string" ? text : "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function isoDate(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value))
    return new Date(value).toISOString().slice(0, 10);
  if (typeof value !== "string" || !value.trim()) return undefined;
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString().slice(0, 10);
}

/** `{ date }` для объекта результата, когда дата есть (без `date: undefined`). */
export function dated(value: unknown): { date: string } | Record<string, never> {
  const d = isoDate(value);
  return d ? { date: d } : {};
}
