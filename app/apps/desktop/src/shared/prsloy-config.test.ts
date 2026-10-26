import { describe, expect, it } from "vite-plus/test";
import {
  buildPrsloyModelsJsonProvider,
  normalizePrsloyBaseUrl,
  PRSLOY_DEFAULT_BASE_URL,
  PRSLOY_MODELS,
  PRSLOY_PROVIDER_COMPAT,
  PRSLOY_SPEED_PREFERENCE,
  PRSLOY_UNPRICED,
  PRSLOY_PRICES_USD_PER_M,
  prsloyModelCost,
  PRSLOY_SPEED_MODES,
  prsloyModelForSpeed,
  prsloySpeedForModel,
} from "./prsloy-config.ts";

const UNMEASURED = ["claude-fable-5", "grok-4.7"];

describe("prsloy config", () => {
  it("knows the gateway's chat models", () => {
    expect(PRSLOY_MODELS.map((m) => m.id)).toEqual([
      "deepseek-v4.1-flash-1017",
      "kimi-k3.1-pro",
      "qwen3.8-max",
      "claude-opus-5-5",
      "claude-fable-5",
      "gpt-6.1-sol",
      "grok-4.7",
    ]);
  });

  it("maps speed modes to catalog models and back", () => {
    const ids = new Set(PRSLOY_MODELS.map((m) => m.id));
    for (const preset of Object.values(PRSLOY_SPEED_MODES))
      expect(ids.has(preset.modelId)).toBe(true);
    expect(prsloyModelForSpeed("fast")).toEqual({
      provider: "prsloy",
      id: "deepseek-v4.1-flash-1017",
    });
    expect(prsloySpeedForModel({ provider: "prsloy", id: "kimi-k3.1-pro" })).toBe("quality");
    expect(prsloySpeedForModel({ provider: "prsloy", id: "qwen3.8-max" })).toBeUndefined();
    expect(prsloySpeedForModel({ provider: "other", id: "kimi-k3.1-pro" })).toBeUndefined();
  });

  it("presets only pick models that reach the vendor as asked (gateway probe 2026-10-25)", () => {
    const presets = [...PRSLOY_SPEED_PREFERENCE.fast, ...PRSLOY_SPEED_PREFERENCE.quality];
    for (const id of ["qwen3.8-max", "grok-4.7", "claude-fable-5"])
      expect(presets).not.toContain(id);
    expect(PRSLOY_SPEED_PREFERENCE.fast[0]).toBe("deepseek-v4.1-flash-1017");
    expect(PRSLOY_SPEED_PREFERENCE.quality[0]).toBe("kimi-k3.1-pro");
    expect(PRSLOY_SPEED_PREFERENCE.quality).not.toContain("deepseek-v4.1-flash-1017");
    // Qwen's channel drops images silently: never send it one.
    expect(PRSLOY_MODELS.find((m) => m.id === "qwen3.8-max")!.input).toEqual(["text"]);
    // No reasoning field for Opus and Fable (effort routes them to worse channels); no developer role.
    for (const id of ["claude-opus-5-5", "claude-fable-5"])
      expect(PRSLOY_MODELS.find((m) => m.id === id)!.reasoning).toBe(false);
    expect(PRSLOY_PROVIDER_COMPAT.supportsDeveloperRole).toBe(false);
    for (const m of PRSLOY_MODELS) expect(m.compat?.supportsDeveloperRole).not.toBe(true);
  });

  it("normalizes gateway base URLs", () => {
    expect(normalizePrsloyBaseUrl(PRSLOY_DEFAULT_BASE_URL)).toBe(PRSLOY_DEFAULT_BASE_URL);
    expect(normalizePrsloyBaseUrl(" https://api.prsloy.online/ ")).toBe(
      "https://api.prsloy.online/v1",
    );
    expect(normalizePrsloyBaseUrl("https://gw.example/proxy/v1/?x=1#y")).toBe(
      "https://gw.example/proxy/v1",
    );
    expect(normalizePrsloyBaseUrl("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080/v1");
    expect(normalizePrsloyBaseUrl("http://api.prsloy.online/v1")).toBeUndefined();
    expect(normalizePrsloyBaseUrl("https://user:pw@host/v1")).toBeUndefined();
    expect(normalizePrsloyBaseUrl("ftp://host")).toBeUndefined();
    expect(normalizePrsloyBaseUrl("not a url")).toBeUndefined();
    expect(normalizePrsloyBaseUrl("")).toBeUndefined();
  });

  it("builds a keyless models.json provider with gateway compat", () => {
    const block = buildPrsloyModelsJsonProvider("https://gw/v1") as {
      apiKey?: string;
      api: string;
      compat: Record<string, unknown>;
      models: { id: string; reasoning: boolean; compat: Record<string, unknown> }[];
    };
    expect(block.apiKey).toBeUndefined();
    expect(block.api).toBe("openai-completions");
    expect(block.compat).toMatchObject({
      supportsDeveloperRole: false,
      supportsStore: false,
      maxTokensField: "max_tokens",
    });
    const byId = Object.fromEntries(block.models.map((m) => [m.id, m]));
    expect(
      byId["deepseek-v4.1-flash-1017"]!.compat.requiresReasoningContentOnAssistantMessages,
    ).toBe(true);
    expect(byId["kimi-k3.1-pro"]!.compat.requiresReasoningContentOnAssistantMessages).toBe(true);
    // Opus: no reasoning effort through the gateway.
    expect(byId["claude-opus-5-5"]!.reasoning).toBe(false);
    expect(byId["claude-opus-5-5"]!.compat.supportsReasoningEffort).toBe(false);
  });

  it("prices every measured model; cache read is 10% of input", () => {
    for (const model of PRSLOY_MODELS) {
      const price = PRSLOY_PRICES_USD_PER_M[model.id];
      // No gateway price measured yet: unpriced on purpose (STATUS-core).
      if (UNMEASURED.includes(model.id)) {
        expect(price, model.id).toBeUndefined();
        continue;
      }
      expect(price, model.id).toBeDefined();
      if (!price) continue;
      // A missing cacheRead bills cache hits as full input (DIARY E9: $1.73 shown vs $0.41).
      expect(price.cacheRead, model.id).toBeCloseTo(price.input / 10, 10);
    }
    expect(prsloyModelCost("deepseek-v4.1-flash-1017")).toEqual({
      input: 0.0012,
      output: 0.0048,
      cacheRead: 0.00012,
      cacheWrite: 0.0012,
    });
    expect(prsloyModelCost("claude-opus-5-5").cacheRead).toBeCloseTo(0.0096, 10);
    expect(prsloyModelCost("kimi-k3.1-pro", 3).output).toBeCloseTo(0.612, 10);
    expect(prsloyModelCost("unknown")).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    const block = buildPrsloyModelsJsonProvider("https://gw/v1") as {
      models: { id: string; cost: { input: number } }[];
    };
    expect(block.models.find((m) => m.id === "qwen3.8-max")!.cost.input).toBe(0.036);
  });
});

describe("model prices", () => {
  it("writes each model's price from the one price table into models.json", () => {
    const provider = buildPrsloyModelsJsonProvider("https://api.prsloy.online/v1") as {
      models: Array<{ id: string; cost: unknown }>;
    };
    for (const model of provider.models) {
      expect(model.cost).toEqual(prsloyModelCost(model.id));
      if (!UNMEASURED.includes(model.id)) expect(model.cost).not.toEqual(PRSLOY_UNPRICED);
    }
    expect(PRSLOY_UNPRICED).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });
});
