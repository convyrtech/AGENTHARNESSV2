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
    maxTokens: 64_000,
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
    maxTokens: 32_000,
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
    id: "qwen3.8-max",
    name: "Qwen 3.8 Max",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 256_000,
    maxTokens: 32_000,
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
    maxTokens: 32_000,
    compat: {
      supportsReasoningEffort: false,
    },
  },
];

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

export function prsloyModelForSpeed(mode: PrsloySpeedMode): { provider: string; id: string } {
  return { provider: PRSLOY_PROVIDER_ID, id: PRSLOY_SPEED_MODES[mode].modelId };
}

/** Reverse lookup for the toggle state; undefined when the model is not a preset. */
export function prsloySpeedForModel(
  model: { provider: string; id: string } | undefined,
): PrsloySpeedMode | undefined {
  if (!model || model.provider !== PRSLOY_PROVIDER_ID) return undefined;
  for (const mode of Object.keys(PRSLOY_SPEED_MODES) as PrsloySpeedMode[]) {
    if (PRSLOY_SPEED_MODES[mode].modelId === model.id) return mode;
  }
  return undefined;
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
export function buildPrsloyModelsJsonProvider(baseUrl: string): Record<string, unknown> {
  return {
    name: "PRSLOY",
    baseUrl,
    api: "openai-completions",
    compat: { ...PRSLOY_PROVIDER_COMPAT },
    models: PRSLOY_MODELS.map((model) => ({
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
