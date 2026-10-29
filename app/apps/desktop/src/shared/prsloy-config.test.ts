import { describe, expect, it } from "vite-plus/test";
import {
  buildPrsloyModelsJsonProvider,
  normalizePrsloyBaseUrl,
  PRSLOY_DEFAULT_BASE_URL,
  PRSLOY_MODELS,
  PRSLOY_PROVIDER_COMPAT,
  PRSLOY_SPEED_PREFERENCE,
  PRSLOY_UNPRICED,
  prsloyModelCost,
  PRSLOY_SPEED_MODES,
  prsloyModelForSpeed,
  prsloySpeedForModel,
} from "./prsloy-config.ts";

const UNMEASURED = [
  "claude-fable-5",
  "grok-4.7",
  // Catalogued 2026-10-27 (#75), no gateway price measured yet:
  "gpt-6.1-terra",
  "gemini-4-argon",
  "mimo-v2.6-pro",
  "glm-5.3",
  "qwen3.8-flash",
  "minimax-m3.1-flash",
  "gemini-3.8-flash",
  "kimi-k3",
  "gpt-6-astra",
  "claude-fable-5-1",
];

describe("prsloy config", () => {
  it("knows the gateway's chat models", () => {
    expect(PRSLOY_MODELS.map((m) => m.id)).toEqual([
      "deepseek-v4.1-flash-1017",
      "deepseek-v4-flash",
      "mimo-v2.6-flash",
      "gpt-6-luna",
      "gpt-5.6-luna",
      "kimi-k3.1-pro",
      "qwen3.8-max",
      "claude-opus-5-5",
      "claude-fable-5",
      "gpt-6.1-sol",
      "grok-4.7",
      // Catalogued after the 2026-10-27 vision probe (#75): the gateway serves these, and a
      // model missing here is text-only in the app — attached pictures are silently dropped.
      "gpt-6.1-terra",
      "gemini-4-argon",
      "mimo-v2.6-pro",
      "glm-5.3",
      "qwen3.8-flash",
      "minimax-m3.1-flash",
      "gemini-3.8-flash",
      "kimi-k3",
      "gpt-6-astra",
      "claude-fable-5-1",
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
    expect(PRSLOY_SPEED_PREFERENCE.fast.slice(1, 5)).toEqual([
      "deepseek-v4-flash",
      "mimo-v2.6-flash",
      "gpt-6-luna",
      "gpt-5.6-luna",
    ]);
    expect(PRSLOY_SPEED_PREFERENCE.quality[0]).toBe("kimi-k3.1-pro");
    expect(PRSLOY_SPEED_PREFERENCE.quality).not.toContain("deepseek-v4.1-flash-1017");
    // Qwen reads the control picture now (probe 2026-10-27, #75); its channel may vary.
    expect(PRSLOY_MODELS.find((m) => m.id === "qwen3.8-max")!.input).toEqual(["text", "image"]);
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

  it("uses the gateway's retail ruble prices, including cache and output", () => {
    for (const model of PRSLOY_MODELS) {
      const price = prsloyModelCost(model.id);
      if (!UNMEASURED.includes(model.id)) expect(price.input, model.id).toBeGreaterThan(0);
    }
    expect(prsloyModelCost("deepseek-v4.1-flash-1017")).toEqual({
      input: 1.04,
      output: 4.1,
      cacheRead: 0.05,
      cacheWrite: 1.3,
    });
    expect(prsloyModelCost("claude-opus-5-5").cacheRead).toBeCloseTo(1.9, 10);
    expect(prsloyModelCost("kimi-k3.1-pro").output).toBe(130);
    expect(prsloyModelCost("deepseek-v4-flash")).toEqual({
      input: 5.5,
      output: 17,
      cacheRead: 0.018,
      cacheWrite: 6.875,
    });
    expect(prsloyModelCost("mimo-v2.6-flash").output).toBe(26);
    expect(prsloyModelCost("gpt-6-luna").input).toBe(8.1);
    expect(prsloyModelCost("gpt-5.6-luna").input).toBe(11);
    expect(prsloyModelCost("unknown")).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    const block = buildPrsloyModelsJsonProvider("https://gw/v1") as {
      models: { id: string; cost: { input: number } }[];
    };
    expect(block.models.find((m) => m.id === "qwen3.8-max")!.cost.input).toBe(4.3);
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
