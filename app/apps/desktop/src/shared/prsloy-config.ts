/**
 * PRSLOY gateway: provider id, default endpoint, model catalog with compat flags,
 * and the «Быстрее / Качественнее» speed presets the UI exposes.
 *
 * Shared by main (seeds the isolated agent home) and renderer (model picker).
 * Pure data + pure helpers only: no Node / DOM imports.
 */

export const PRSLOY_PROVIDER_ID = "prsloy";
export const PRSLOY_DEFAULT_BASE_URL = "https://api.prsloy.online/v1";

/** Subset of pi `openai-completions` compat fields we set (docs/models-configuration.md). */
export type PrsloyCompat = {
  supportsStore?: boolean;
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  requiresReasoningContentOnAssistantMessages?: boolean;
  thinkingFormat?: "openai" | "deepseek" | "qwen";
};

/** Price in US dollars per 1M tokens (pi's `models.json` cost unit). */
export type PrsloyModelCost = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

/** No price known: pi then counts the model as free and the UI hides the ruble cost. */
export const PRSLOY_UNPRICED: PrsloyModelCost = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export type PrsloyModelDef = {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  compat: PrsloyCompat;
  /** pi thinking level → value sent; `null` hides the level (models.json `thinkingLevelMap`). */
  thinkingLevelMap?: Partial<Record<PrsloyThinkingLevel, string | null>>;
  /** Extra request fields on every call (models.json `samplingParams`). */
  samplingParams?: Record<string, unknown>;
};

export type PrsloyThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Provider-level compat. Pi detects compat by URL, so behind our gateway every model
 * would get the stock OpenAI profile (developer role, max_completion_tokens, store).
 * The gateway relays to vendors that reject those, so pin them off here.
 */
export const PRSLOY_PROVIDER_COMPAT: PrsloyCompat = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  maxTokensField: "max_tokens",
};

/**
 * Output limit asked of a model: the smaller of the owner's ceiling (128k; the gateway took
 * 32k, 64k and 128k for all models) and the model's own output limit (PRSLOY_OUTPUT_LIMITS).
 * A gateway that refuses it — 400 about `max_tokens`, or 402 (a vendor that won't reserve that
 * much: kimi on 26.10 answered 402 to ≥ 32 000 and 200 to ≤ 4 000) — gets the next value
 * down, silently, from the agent host (agent-host/prsloy-fetch.ts; the bench uses the same).
 */
export const PRSLOY_MAX_TOKENS = 128_000;
export const PRSLOY_MAX_TOKENS_FALLBACK: readonly number[] = [64_000, 32_000, 16_000, 8_000];

/**
 * The model's own output limit, with where the number comes from (#39). The gateway's
 * `/v1/models` (New API) lists ids only, so the table is ours; `null` — no verified number,
 * the owner's ceiling applies. Only numbers seen in a primary source go here.
 */
export const PRSLOY_OUTPUT_LIMITS: Readonly<
  Record<string, { tokens: number | null; source: string }>
> = {
  "deepseek-v4.1-flash-1017": {
    tokens: 393_216,
    source:
      "research/07 §2.1: DeepSeek Models & Pricing — output up to 384K, max 393 216 [VERIFIED]",
  },
  "kimi-k3.1-pro": {
    tokens: null,
    source:
      "research/07 §1.2 has Kimi K3 (131K by default), not K3.1 Pro; not verified for K3.1 Pro",
  },
  "qwen3.8-max": {
    tokens: 131_072,
    source:
      "research/07 §2.4: Qwen3.8-Max API — up to 131K output (thinking_budget ≤ 32 768 is reasoning only, STATUS-core §33)",
  },
  "claude-opus-5-5": {
    tokens: 128_000,
    source: "STATUS-core §34: Opus max_tokens ≤ 128K (dossier, [V])",
  },
  "claude-fable-5": { tokens: null, source: "no number in our sources" },
  "gpt-6.1-sol": { tokens: null, source: "no number in our sources" },
  "grok-4.7": { tokens: null, source: "research/07 §1.2: «Н/Д в собранных доках»" },
};

/** `max_tokens` the catalog asks of a model: min(owner's ceiling, its own limit). */
export function prsloyMaxTokens(modelId: string): number {
  const own = PRSLOY_OUTPUT_LIMITS[modelId]?.tokens;
  return own ? Math.min(PRSLOY_MAX_TOKENS, own) : PRSLOY_MAX_TOKENS;
}

/**
 * Model catalog. Reasoning content is replayed verbatim by pi (the thinking block keeps
 * the source field name as its signature); DeepSeek and Kimi also need an empty
 * `reasoning_content` on assistant turns that had none, or they answer 400 with tools.
 */
export const PRSLOY_MODELS: readonly PrsloyModelDef[] = [
  {
    id: "deepseek-v4.1-flash-1017",
    name: "DeepSeek V4.1 Flash",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 128_000,
    maxTokens: prsloyMaxTokens("deepseek-v4.1-flash-1017"),
    compat: {
      thinkingFormat: "deepseek",
      supportsReasoningEffort: true,
      requiresReasoningContentOnAssistantMessages: true,
    },
  },
  {
    id: "kimi-k3.1-pro",
    name: "Kimi K3.1 Pro",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 256_000,
    maxTokens: prsloyMaxTokens("kimi-k3.1-pro"),
    compat: {
      thinkingFormat: "openai",
      supportsReasoningEffort: true,
      requiresReasoningContentOnAssistantMessages: true,
    },
    // Thinking can't be turned off, and changing effort mid-session drops the KV cache:
    // one level, `high` (the vendor default `max` costs ×3 tokens through the relay).
    thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: "high" },
  },
  {
    // Through the gateway (2026-10-25 probe) Qwen goes via a third-party coding-assistant channel that
    // adds a hidden prompt, drops our system/developer messages and silently drops images: text only,
    // and no preset picks it. Still selectable by hand.
    id: "qwen3.8-max",
    name: "Qwen 3.8 Max",
    reasoning: true,
    input: ["text"],
    contextWindow: 256_000,
    maxTokens: prsloyMaxTokens("qwen3.8-max"),
    compat: {
      thinkingFormat: "qwen",
      supportsReasoningEffort: true,
    },
    // Alibaba defaults it to true, but relays drop the default: Qwen then calls one tool
    // per message.
    samplingParams: { parallel_tool_calls: true },
  },
  {
    // No reasoning effort parameter: through the gateway `effort` routes Opus to a bad
    // supplier. reasoning:false keeps pi from sending any thinking field at all.
    id: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 200_000,
    maxTokens: prsloyMaxTokens("claude-opus-5-5"),
    compat: {
      supportsReasoningEffort: false,
    },
  },
  // Served by the gateway (2026-10-25). No effort for them either: same rule as Opus.
  {
    id: "claude-fable-5",
    name: "Claude Fable 5",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 200_000,
    maxTokens: prsloyMaxTokens("claude-fable-5"),
    compat: { supportsReasoningEffort: false },
  },
  {
    id: "gpt-6.1-sol",
    name: "GPT-6.1 Sol",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 400_000,
    maxTokens: prsloyMaxTokens("gpt-6.1-sol"),
    compat: { supportsReasoningEffort: false },
  },
  {
    id: "grok-4.7",
    name: "Grok 4.7",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 256_000,
    maxTokens: prsloyMaxTokens("grok-4.7"),
    compat: { supportsReasoningEffort: false },
  },
];

/** Image generators the gateway lists next to chat models: no `chat/completions`. */
const IMAGE_MODEL =
  /(^|[-_/])(image|img)([-_.]|$)|^(gpt-image|dall-e|nano-banana|imagen|flux|midjourney|seedream|recraft|stable-diffusion|sdxl?)/iu;

export function isPrsloyChatModelId(id: string): boolean {
  return !IMAGE_MODEL.test(id);
}

/**
 * The models to offer: the catalog filtered to what the gateway serves (`/v1/models`),
 * plus chat models it serves that the catalog doesn't know yet (provider defaults, no
 * price). Without a list (not checked yet, or a gateway without `/models`) the catalog.
 */
export function prsloyAvailableModels(available?: readonly string[]): PrsloyModelDef[] {
  if (!available) return [...PRSLOY_MODELS];
  const served = new Set(available.filter(isPrsloyChatModelId));
  const known = PRSLOY_MODELS.filter((model) => served.has(model.id));
  const unknown = [...served]
    .filter((id) => !PRSLOY_MODELS.some((model) => model.id === id))
    .map(
      (id): PrsloyModelDef => ({
        id,
        name: id,
        reasoning: false,
        input: ["text"],
        contextWindow: 128_000,
        maxTokens: PRSLOY_MAX_TOKENS,
        compat: {},
      }),
    );
  return [...known, ...unknown];
}

/**
 * Gateway prices, USD per 1M tokens (measured gateway cost for now). `cacheRead` is 10% of
 * input (measured for deepseek/kimi, assumed for qwen/claude until measured): without it
 * cache reads were billed as full input and tripped the task budget early.
 * Retail = cost × PRSLOY_PRICE_MULTIPLIER.
 */
export const PRSLOY_PRICES_USD_PER_M: Readonly<
  Record<string, { input: number; output: number; cacheRead?: number }>
> = {
  "deepseek-v4.1-flash-1017": { input: 0.0012, output: 0.0048, cacheRead: 0.00012 },
  "kimi-k3.1-pro": { input: 0.041, output: 0.204, cacheRead: 0.0041 },
  "qwen3.8-max": { input: 0.036, output: 0.108, cacheRead: 0.0036 },
  "claude-opus-5-5": { input: 0.096, output: 0.48, cacheRead: 0.0096 },
  // Measured gateway range $0.015–0.077 / $0.077–0.385 (8 suppliers, REPORT-2026-10-22):
  // the upper end, so the ruble cost is never understated.
  "gpt-6.1-sol": { input: 0.077, output: 0.385, cacheRead: 0.0077 },
  // claude-fable-5, grok-4.7: no gateway price measured yet → unpriced (no ruble cost),
  // not the vendors' list prices (those are ~40× the gateway's, STATUS-core).
};

/** One knob for the owner to move from cost to retail pricing. */
export const PRSLOY_PRICE_MULTIPLIER = 1;

/** pi `cost` block (USD per 1M tokens) for a catalog model, multiplier applied. */
export function prsloyModelCost(
  modelId: string,
  multiplier: number = PRSLOY_PRICE_MULTIPLIER,
): PrsloyModelCost {
  const price = PRSLOY_PRICES_USD_PER_M[modelId];
  if (!price) return { ...PRSLOY_UNPRICED };
  const input = price.input * multiplier;
  return {
    input,
    output: price.output * multiplier,
    cacheRead: (price.cacheRead ?? price.input) * multiplier,
    cacheWrite: input,
  };
}

export type PrsloySpeedMode = "fast" | "quality";

/**
 * «Быстрее / Качественнее» → model id: the single source of truth. The renderer's
 * `lib/model-tiers.ts` derives `MODEL_TIERS` from this; labels are i18n keys.
 */
export const PRSLOY_SPEED_MODES: Readonly<
  Record<PrsloySpeedMode, { modelId: string; labelKey: string }>
> = {
  fast: { modelId: "deepseek-v4.1-flash-1017", labelKey: "composer.tier.fast" },
  quality: { modelId: "kimi-k3.1-pro", labelKey: "composer.tier.quality" },
};

export const PRSLOY_DEFAULT_SPEED_MODE: PrsloySpeedMode = "fast";

/**
 * Owner's rule «лучший результат за минимум денег»: each preset is the first model of its
 * list the gateway serves. The first entry is PRSLOY_SPEED_MODES' model.
 *
 * Only models that reach the vendor as asked (gateway probe 2026-10-25): DeepSeek and Kimi are genuine;
 * GPT-6.1 Sol sometimes goes through another channel but still obeys our system message; Opus obeys it
 * too but streams nothing until the whole answer is ready (quality's last resort). Never in a preset:
 * Qwen (our system message is dropped), Grok (tool calls come back as text, minutes of hidden thinking),
 * Fable (its channel overrides our system message). They stay selectable by hand.
 */
export const PRSLOY_SPEED_PREFERENCE: Readonly<Record<PrsloySpeedMode, readonly string[]>> = {
  fast: ["deepseek-v4.1-flash-1017", "kimi-k3.1-pro", "gpt-6.1-sol"],
  // No DeepSeek in «Качественнее» (owner, 2026-10-26): a person who chose quality never silently gets
  // the fast model; without Kimi and GPT-6.1 Sol it falls to Opus.
  quality: ["kimi-k3.1-pro", "gpt-6.1-sol", "claude-opus-5-5"],
};

/** The preset's model id for what the gateway serves (`undefined` list = not known yet). */
export function prsloySpeedModelId(mode: PrsloySpeedMode, available?: readonly string[]): string {
  const list = PRSLOY_SPEED_PREFERENCE[mode];
  if (!available) return list[0]!;
  const served = new Set(available);
  return list.find((id) => served.has(id)) ?? available.find(isPrsloyChatModelId) ?? list[0]!;
}

export function prsloyModelForSpeed(
  mode: PrsloySpeedMode,
  available?: readonly string[],
): { provider: string; id: string } {
  return { provider: PRSLOY_PROVIDER_ID, id: prsloySpeedModelId(mode, available) };
}

/** Reverse lookup for the toggle state; undefined when the model is not a preset. */
export function prsloySpeedForModel(
  model: { provider: string; id: string } | undefined,
  available?: readonly string[],
): PrsloySpeedMode | undefined {
  if (!model || model.provider !== PRSLOY_PROVIDER_ID) return undefined;
  for (const mode of Object.keys(PRSLOY_SPEED_PREFERENCE) as PrsloySpeedMode[]) {
    if (prsloySpeedModelId(mode, available) === model.id) return mode;
  }
  return undefined;
}

/**
 * Where to go when `from` stops being served mid-session: the next served model of the
 * preset list it belongs to (fast first), else the fast preset.
 */
export function prsloyFallbackModelId(
  from: string,
  available: readonly string[],
): string | undefined {
  const served = new Set(available.filter((id) => id !== from && isPrsloyChatModelId(id)));
  for (const mode of ["fast", "quality"] as const) {
    const list = PRSLOY_SPEED_PREFERENCE[mode];
    const at = list.indexOf(from);
    if (at < 0) continue;
    const next = list.slice(at + 1).find((id) => served.has(id));
    if (next) return next;
  }
  const fast = PRSLOY_SPEED_PREFERENCE.fast.find((id) => served.has(id));
  return fast ?? [...served][0];
}

/**
 * Normalize a user-typed gateway URL to `https://host[/path]/v1` without trailing slash.
 * Returns undefined for anything that is not an absolute http(s) URL.
 * Plain http is only accepted for loopback (local mock / self-test).
 */
export function normalizePrsloyBaseUrl(raw: string | undefined | null): string | undefined {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return undefined;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return undefined;
  if (url.username || url.password) return undefined;
  url.search = "";
  url.hash = "";
  let path = url.pathname.replace(/\/+$/u, "");
  if (!/\/v\d+$/u.test(path)) path = `${path}/v1`;
  return `${url.origin}${path}`;
}

/**
 * The `providers.prsloy` block for pi `models.json`. No `apiKey`: the key never touches
 * disk in plain text; the agent host sets it as a pi runtime key.
 */
export function buildPrsloyModelsJsonProvider(
  baseUrl: string,
  available?: readonly string[],
): Record<string, unknown> {
  return {
    name: "PRSLOY",
    baseUrl,
    api: "openai-completions",
    compat: { ...PRSLOY_PROVIDER_COMPAT },
    models: prsloyAvailableModels(available).map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: [...model.input],
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      cost: prsloyModelCost(model.id),
      compat: { ...model.compat },
      ...(model.thinkingLevelMap ? { thinkingLevelMap: { ...model.thinkingLevelMap } } : {}),
      ...(model.samplingParams ? { samplingParams: { ...model.samplingParams } } : {}),
    })),
  };
}
