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

/**
 * Причина сетевой ошибки — фиксированными словами. Текст исключения в ответ инструмента не идёт: в нём бывает
 * адрес с токеном или значение заголовка (Node: «Invalid header value "Bearer sk-…"»), а ответ видит модель.
 */
export function netReason(e: unknown): string {
  const err = e as { name?: string; code?: string; cause?: { code?: string; name?: string } };
  const code = err?.cause?.code ?? err?.code ?? "";
  const name = err?.cause?.name ?? err?.name ?? "";
  if (name === "TimeoutError" || name === "AbortError" || code === "UND_ERR_CONNECT_TIMEOUT")
    return "время ожидания вышло";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "имя сайта не найдено";
  if (code === "ECONNREFUSED") return "соединение отклонено";
  if (code === "ECONNRESET" || code === "UND_ERR_SOCKET") return "соединение сброшено";
  if (/CERT|SSL|TLS/i.test(code)) return "ошибка сертификата сайта";
  return "сеть недоступна";
}

/** Таймаут запроса вместе с отменой хода (Esc): что раньше. */
export function timeoutSignal(ms: number, signal?: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([AbortSignal.timeout(ms), signal]) : AbortSignal.timeout(ms);
}
