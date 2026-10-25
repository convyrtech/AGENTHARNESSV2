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

export type PrsloyModelDef = {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  compat: PrsloyCompat;
};

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
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { ...model.compat },
    })),
  };
}
