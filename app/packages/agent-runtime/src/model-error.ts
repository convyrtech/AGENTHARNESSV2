/**
 * Stable code for a failed model turn, so the UI can show a human error card («Нет связи с
 * сервером… Повторить») instead of pi's raw provider text. Matched against what pi 1.4
 * actually reports (see test/model-error.test.ts):
 *   gateway down / reset      → "Connection error."
 *   stream cut mid-turn       → "terminated"
 *   HTTP error                → "<status>: <body>" or "<status> <body>"
 */
export type ModelErrorCode =
  | "network"
  | "timeout"
  | "auth"
  | "no_balance"
  | "rate_limit"
  /** The gateway doesn't know / doesn't serve the requested model (404, model_not_found). */
  | "model_unavailable"
  | "server"
  | "aborted"
  | "unknown";

export function classifyModelError(
  message: string | undefined,
  stopReason?: string,
): ModelErrorCode {
  if (stopReason === "aborted") return "aborted";
  const text = (message ?? "").trim();
  const status = /^(\d{3})\b/u.exec(text)?.[1];
  if (status) {
    const code = Number(status);
    if (code === 401 || code === 403) return "auth";
    if (code === 402) return "no_balance";
    if (code === 429) return "rate_limit";
    if (code === 404) return "model_unavailable";
    if (code === 408 || code === 504) return "timeout";
    if (code >= 500) return "server";
  }
  if (/insufficient (balance|funds|quota)|out of credits|balance/iu.test(text)) return "no_balance";
  if (/invalid api key|unauthori[sz]ed|forbidden/iu.test(text)) return "auth";
  if (/rate.?limit|too many requests/iu.test(text)) return "rate_limit";
  if (/model_not_found|does not exist|no such model|model (is )?not available/iu.test(text)) {
    return "model_unavailable";
  }
  // The reliability proxy waited out every attempt with no first token: the model is silent, not the network.
  if (/timed? ?out|timeout|ETIMEDOUT|модель долго не отвечает|prsloy_model_slow/iu.test(text))
    return "timeout";
  if (
    /^connection error|^terminated$|связь с моделью оборвалась|prsloy_stream_interrupted|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network|getaddrinfo|other side closed/iu.test(
      text,
    )
  ) {
    return "network";
  }
  if (/overloaded|bad gateway|service unavailable|internal server error/iu.test(text)) {
    return "server";
  }
  return "unknown";
}
