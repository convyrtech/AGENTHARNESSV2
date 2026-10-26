/**
 * Quiet recovery for PRSLOY gateway requests, under pi (the host's `fetch`):
 *
 * - 400 about `max_tokens`, or any 402 → the same request again with a smaller `max_tokens`
 *   (PRSLOY_MAX_TOKENS_FALLBACK). A 402 is how a vendor says it won't reserve that much output
 *   (kimi, 26.10: 402 at ≥ 32 000, 200 at ≤ 4 000); a real empty balance stays 402 at every
 *   step, which costs a few refused requests and still ends on the balance card. The value
 *   that went through is used straight away for that model for PRSLOY_CAP_TTL_MS;
 * - the model is not served (404, `model_not_found`, …) → the gateway's list is read
 *   again and the request goes to the next model of its preset (prsloyFallbackModelId);
 *   later requests for that model go straight there, and the host is told once (it
 *   switches the session's model and shows «Модель X недоступна, работаю на Y»).
 *
 * Only `POST …/chat/completions` carrying the gateway key, once per request: requests
 * sent from here carry a marker header, so the harness's reliability proxy (which
 * forwards headers) hands them on untouched.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PRSLOY_MAX_TOKENS_FALLBACK,
  PRSLOY_MODELS,
  PRSLOY_PROVIDER_ID,
  prsloyFallbackModelId,
} from "../shared/prsloy-config.ts";

export const PRSLOY_FETCH_MARKER = "x-prsloy-fallback";

/** How long a stepped-down `max_tokens` holds for a model before 128k is tried again. */
export const PRSLOY_CAP_TTL_MS = 10 * 60 * 1000;

const MAX_TOKENS_REJECTED =
  /max_(?:completion_|output_)?tokens|max output tokens|maximum (?:output )?tokens/iu;
const MODEL_UNAVAILABLE =
  /model_not_found|model[^.]{0,40}(?:does not exist|not found|not available|unavailable|not supported)|no (?:available )?(?:channel|provider|distributor)[^.]{0,40}model|unknown model|invalid model/iu;

export type PrsloyFetchOptions = {
  base: typeof fetch;
  apiKey: string;
  /** What the gateway serves right now (its `/v1/models`). */
  listModels(): Promise<string[]>;
  onModelSwitch?(from: string, to: string): void;
  /** For tests: the clock. */
  now?(): number;
};

type Attempt = { response: Response; text?: string };

function headerValue(headers: HeadersInit | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  return new Headers(headers).get(name) ?? undefined;
}

async function readError(response: Response): Promise<Attempt> {
  const text = await response.text();
  // Hand pi a fresh response with the same status and body.
  return {
    text,
    response: new Response(text, { status: response.status, headers: response.headers }),
  };
}

export function createPrsloyFetch(options: PrsloyFetchOptions): typeof fetch {
  const switched = new Map<string, string>();
  const capped = new Map<string, { tokens: number; until: number }>();
  const now = (): number => options.now?.() ?? Date.now();

  const prsloyFetch = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : undefined;
    if (
      url === undefined ||
      (init?.method ?? "GET").toUpperCase() !== "POST" ||
      !/\/chat\/completions(?:\?|$)/u.test(url) ||
      typeof init?.body !== "string" ||
      headerValue(init.headers, PRSLOY_FETCH_MARKER) ||
      headerValue(init.headers, "authorization") !== `Bearer ${options.apiKey}`
    ) {
      return options.base(input, init);
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(init.body) as Record<string, unknown>;
    } catch {
      return options.base(input, init);
    }
    const headers = new Headers(init.headers);
    headers.set(PRSLOY_FETCH_MARKER, "1");
    const send = async (next: Record<string, unknown>): Promise<Attempt> => {
      const response = await options.base(url, {
        ...init,
        headers,
        body: JSON.stringify(next),
      });
      return response.ok ? { response } : readError(response);
    };

    const model = typeof body.model === "string" ? body.model : undefined;
    if (model && switched.has(model)) body = { ...body, model: switched.get(model) };
    const asked = typeof body.model === "string" ? body.model : undefined;
    const cap = asked ? capped.get(asked) : undefined;
    if (
      cap &&
      cap.until > now() &&
      typeof body.max_tokens === "number" &&
      body.max_tokens > cap.tokens
    )
      body = { ...body, max_tokens: cap.tokens };
    let attempt = await send(body);

    // Output limit the gateway or the vendor won't take: step down, quietly.
    const refused = (a: Attempt) =>
      a.response.status === 402 ||
      (a.response.status === 400 && MAX_TOKENS_REJECTED.test(a.text ?? ""));
    let stepped = false;
    for (const limit of PRSLOY_MAX_TOKENS_FALLBACK) {
      if (!refused(attempt)) break;
      if (typeof body.max_tokens === "number" && body.max_tokens <= limit) continue;
      body = { ...body, max_tokens: limit };
      stepped = true;
      attempt = await send(body);
    }
    if (stepped && asked && attempt.response.ok && typeof body.max_tokens === "number")
      capped.set(asked, { tokens: body.max_tokens, until: now() + PRSLOY_CAP_TTL_MS });

    // The model is gone: once, to the next served model of its preset.
    const current = typeof body.model === "string" ? body.model : undefined;
    const gone =
      attempt.response.status === 404 ||
      ((attempt.response.status === 400 || attempt.response.status === 503) &&
        MODEL_UNAVAILABLE.test(attempt.text ?? ""));
    if (current && gone) {
      let served: string[] = [];
      try {
        served = await options.listModels();
      } catch {
        served = [];
      }
      const next = served.length ? prsloyFallbackModelId(current, served) : undefined;
      if (next && next !== current) {
        const retry = await send({ ...body, model: next });
        if (retry.response.ok) {
          if (model) switched.set(model, next);
          switched.set(current, next);
          options.onModelSwitch?.(current, next);
        }
        return retry.response;
      }
    }
    return attempt.response;
  };
  return prsloyFetch as typeof fetch;
}

/** The real gateway URL from models.json (the harness may route pi through its proxy). */
function gatewayBaseUrl(agentDir: string | undefined): string | undefined {
  if (!agentDir) return undefined;
  try {
    const models = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8")) as {
      providers?: Record<string, { baseUrl?: unknown }>;
    };
    const baseUrl = models.providers?.[PRSLOY_PROVIDER_ID]?.baseUrl;
    return typeof baseUrl === "string" ? baseUrl.replace(/\/+$/u, "") : undefined;
  } catch {
    return undefined;
  }
}

/** Wrap the host's global fetch (pi's OpenAI client and the harness proxy both use it). */
export function installPrsloyFetch(options: {
  apiKey: string;
  agentDir: () => string | undefined;
  onModelSwitch(from: string, to: string): void;
}): void {
  const base = globalThis.fetch.bind(globalThis);
  globalThis.fetch = createPrsloyFetch({
    base,
    apiKey: options.apiKey,
    async listModels() {
      const url = gatewayBaseUrl(options.agentDir());
      if (!url) return [];
      const response = await base(`${url}/models`, {
        headers: { Authorization: `Bearer ${options.apiKey}`, Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return [];
      const body = (await response.json()) as { data?: { id?: unknown }[] };
      return (body.data ?? [])
        .map((m) => m.id)
        .filter((id): id is string => typeof id === "string");
    },
    onModelSwitch: (from, to) => options.onModelSwitch(from, to),
  });
}

/** «Модель X недоступна, работаю на Y» with the catalog's display names. */
export function modelSwitchText(from: string, to: string): string {
  const name = (id: string) => PRSLOY_MODELS.find((m) => m.id === id)?.name ?? id;
  return `Модель ${name(from)} недоступна, работаю на ${name(to)}`;
}
