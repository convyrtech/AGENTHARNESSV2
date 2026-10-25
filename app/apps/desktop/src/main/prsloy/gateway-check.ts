/**
 * Validate a PRSLOY key against the gateway before saving it.
 *
 * `GET {base}/models` with the key; if the gateway does not expose the list (404/405),
 * fall back to a one-token completion on the fast model. Failures map to stable codes
 * the renderer turns into human Russian («Ключ не подошёл», «Нет связи с сервером»).
 */
import { PRSLOY_SPEED_MODES } from "../../shared/prsloy-config.ts";

export type GatewayErrorCode =
  /** 401 / 403: wrong or revoked key. */
  | "invalid_key"
  /** 402: key is fine, balance is empty. */
  | "no_balance"
  /** DNS / TCP / TLS failure: no connection to the gateway. */
  | "network"
  | "timeout"
  /** Gateway answered 5xx or something unexpected. */
  | "server"
  /** Base URL is not a valid gateway address. */
  | "bad_url";

export type GatewayCheckResult =
  | { ok: true; modelIds: string[]; via: "models" | "completion" }
  | { ok: false; code: GatewayErrorCode; status?: number };

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function codeForStatus(status: number): GatewayErrorCode {
  if (status === 401 || status === 403) return "invalid_key";
  if (status === 402) return "no_balance";
  return "server";
}

function parseModelIds(body: unknown): string[] {
  if (!body || typeof body !== "object" || !("data" in body)) return [];
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return data
    .map((row) =>
      row && typeof row === "object" && typeof (row as { id?: unknown }).id === "string"
        ? (row as { id: string }).id
        : undefined,
    )
    .filter((id): id is string => Boolean(id));
}

async function request(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response | GatewayErrorCode> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal, redirect: "error" });
  } catch {
    return controller.signal.aborted ? "timeout" : "network";
  } finally {
    clearTimeout(timer);
  }
}

export async function checkPrsloyKey(options: {
  baseUrl: string;
  apiKey: string;
  fetch: FetchLike;
  timeoutMs?: number;
}): Promise<GatewayCheckResult> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const key = options.apiKey.trim();
  if (!key) return { ok: false, code: "invalid_key" };
  let base: string;
  try {
    base = new URL(options.baseUrl).toString().replace(/\/+$/u, "");
  } catch {
    return { ok: false, code: "bad_url" };
  }
  const headers = { Authorization: `Bearer ${key}`, Accept: "application/json" };

  const listed = await request(options.fetch, `${base}/models`, { headers }, timeoutMs);
  if (typeof listed === "string") return { ok: false, code: listed };
  if (listed.ok) {
    let body: unknown;
    try {
      body = await listed.json();
    } catch {
      body = undefined;
    }
    return { ok: true, modelIds: parseModelIds(body), via: "models" };
  }
  if (listed.status !== 404 && listed.status !== 405) {
    return { ok: false, code: codeForStatus(listed.status), status: listed.status };
  }

  const completion = await request(
    options.fetch,
    `${base}/chat/completions`,
    {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: PRSLOY_SPEED_MODES.fast.modelId,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        stream: false,
      }),
    },
    timeoutMs,
  );
  if (typeof completion === "string") return { ok: false, code: completion };
  if (completion.ok) return { ok: true, modelIds: [], via: "completion" };
  return { ok: false, code: codeForStatus(completion.status), status: completion.status };
}
