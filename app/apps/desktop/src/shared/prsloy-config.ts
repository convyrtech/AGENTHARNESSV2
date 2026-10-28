/**
 * PRSLOY gateway: provider id, default endpoint, model catalog with compat flags,
 * and the «Быстрее / Качественнее» speed presets the UI exposes.
 *
 * Shared by main (seeds the isolated agent home) and renderer (model picker).
 * Pure data + pure helpers only: no Node / DOM imports.
 */
import { prsloyModelCostRub, type RubPricePerM } from "./prsloy-prices.ts";

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

/** Price in rubles per 1M tokens (the gateway's retail price; pi's `models.json` `cost` unit). */
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
  "gpt-6.1-terra": { tokens: null, source: "no number in our sources" },
  "gemini-4-argon": { tokens: null, source: "no number in our sources" },
  "mimo-v2.6-pro": { tokens: null, source: "no number in our sources" },
  "glm-5.3": { tokens: null, source: "no number in our sources" },
  "qwen3.8-flash": { tokens: null, source: "no number in our sources" },
  "minimax-m3.1-flash": { tokens: null, source: "no number in our sources" },
  "gemini-3.8-flash": { tokens: null, source: "no number in our sources" },
  "kimi-k3": { tokens: null, source: "no number in our sources" },
  "gpt-6-astra": { tokens: null, source: "no number in our sources" },
  "claude-fable-5-1": { tokens: null, source: "no number in our sources" },
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
    // Through the gateway (2026-10-25 probe) Qwen went via a coding-assistant channel that added a
    // hidden prompt and dropped our system/developer messages, so no preset picks it. Still selectable
    // by hand. The image flag: a plain vision request saw the control picture (probe 2026-10-27, #75) —
    // the 2026-10-25 channel dropped images, so the channel may vary.
    id: "qwen3.8-max",
    name: "Qwen 3.8 Max",
    reasoning: true,
    input: ["text", "image"],
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
  {
    // Catalogued from the gateway's /v1/models; image: read "42" off the control picture (vision probe 2026-10-27, #75).
    id: "gpt-6.1-terra",
    name: "gpt-6.1-terra",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 128_000,
    maxTokens: prsloyMaxTokens("gpt-6.1-terra"),
    compat: { supportsReasoningEffort: false },
  },
  {
    // Catalogued from the gateway's /v1/models; image: read "42" off the control picture (vision probe 2026-10-27, #75).
    id: "gemini-4-argon",
    name: "gemini-4-argon",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 128_000,
    maxTokens: prsloyMaxTokens("gemini-4-argon"),
    compat: { supportsReasoningEffort: false },
  },
  {
    // Catalogued from the gateway's /v1/models; text: answered the control picture cannot be seen (vision probe 2026-10-27, #75).
    id: "mimo-v2.6-pro",
    name: "mimo-v2.6-pro",
    reasoning: false,
    input: ["text"],
    contextWindow: 128_000,
    maxTokens: prsloyMaxTokens("mimo-v2.6-pro"),
    compat: { supportsReasoningEffort: false },
  },
  {
    // Catalogued from the gateway's /v1/models; text: answered the control picture cannot be seen (vision probe 2026-10-27, #75).
    id: "glm-5.3",
    name: "glm-5.3",
    reasoning: false,
    input: ["text"],
    contextWindow: 128_000,
    maxTokens: prsloyMaxTokens("glm-5.3"),
    compat: { supportsReasoningEffort: false },
  },
  {
    // Catalogued from the gateway's /v1/models; image: read "42" off the control picture (vision probe 2026-10-27, #75).
    id: "qwen3.8-flash",
    name: "qwen3.8-flash",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 128_000,
    maxTokens: prsloyMaxTokens("qwen3.8-flash"),
    compat: { supportsReasoningEffort: false },
  },
  {
    // Catalogued from the gateway's /v1/models; image: read "42" off the control picture (vision probe 2026-10-27, #75).
    id: "minimax-m3.1-flash",
    name: "minimax-m3.1-flash",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 128_000,
    maxTokens: prsloyMaxTokens("minimax-m3.1-flash"),
    compat: { supportsReasoningEffort: false },
  },
  {
    // Catalogued from the gateway's /v1/models; image: read "42" off the control picture (vision probe 2026-10-27, #75).
    id: "gemini-3.8-flash",
    name: "gemini-3.8-flash",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 128_000,
    maxTokens: prsloyMaxTokens("gemini-3.8-flash"),
    compat: { supportsReasoningEffort: false },
  },
  {
    // Catalogued from the gateway's /v1/models; image: read "42" off the control picture (vision probe 2026-10-27, #75).
    id: "kimi-k3",
    name: "kimi-k3",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 128_000,
    maxTokens: prsloyMaxTokens("kimi-k3"),
    compat: { supportsReasoningEffort: false },
  },
  {
    // Catalogued from the gateway's /v1/models; text: answered the control picture cannot be seen (vision probe 2026-10-27, #75).
    id: "gpt-6-astra",
    name: "gpt-6-astra",
    reasoning: false,
    input: ["text"],
    contextWindow: 128_000,
    maxTokens: prsloyMaxTokens("gpt-6-astra"),
    compat: { supportsReasoningEffort: false },
  },
  {
    // Catalogued from the gateway's /v1/models; image: read "42" off the control picture (vision probe 2026-10-27, #75).
    id: "claude-fable-5-1",
    name: "claude-fable-5-1",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 128_000,
    maxTokens: prsloyMaxTokens("claude-fable-5-1"),
    compat: { supportsReasoningEffort: false },
  },
];

/** Image generators the gateway lists next to chat models: no `chat/completions`. */
const IMAGE_MODEL =
  /(^|[-_/])(image|img)([-_.]|$)|^(gpt-image|dall-e|nano-banana|imagen|flux|midjourney|seedream|recraft|stable-diffusion|sdxl?|ideogram)/iu;

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
 * pi's `cost` block for `models.json`: rubles per 1M tokens, the gateway's retail price (#52).
 * The block is where pi keeps «price per million»; here the unit is the site's — rubles — so
 * `usage.cost` and the «чат 8,40 ₽» chip need no conversion and no dollar rate.
 *
 * The prices themselves live in `shared/prsloy-prices.ts`: the gateway's live `/api/pricing`
 * when main has read it, the bundled snapshot otherwise. A model with no price stays unpriced —
 * no rubles at all rather than a guess.
 */
export function prsloyModelCost(
  modelId: string,
  prices?: Readonly<Record<string, RubPricePerM>>,
): PrsloyModelCost {
  return prsloyModelCostRub(modelId, prices);
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
  /** Retail prices in ₽ per 1M; undefined = the bundled snapshot (#52). */
  prices?: Readonly<Record<string, RubPricePerM>>,
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
      cost: prsloyModelCost(model.id, prices),
      compat: { ...model.compat },
      ...(model.thinkingLevelMap ? { thinkingLevelMap: { ...model.thinkingLevelMap } } : {}),
      ...(model.samplingParams ? { samplingParams: { ...model.samplingParams } } : {}),
    })),
  };
}
