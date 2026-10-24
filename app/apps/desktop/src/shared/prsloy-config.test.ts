import { describe, expect, it } from "vite-plus/test";
import {
  buildPrsloyModelsJsonProvider,
  normalizePrsloyBaseUrl,
  PRSLOY_DEFAULT_BASE_URL,
  PRSLOY_MODELS,
  PRSLOY_SPEED_MODES,
  prsloyModelForSpeed,
  prsloySpeedForModel,
} from "./prsloy-config.ts";

describe("prsloy config", () => {
  it("ships the four gateway models", () => {
    expect(PRSLOY_MODELS.map((m) => m.id)).toEqual([
      "deepseek-v4.1-flash-1017",
      "kimi-k3.1-pro",
      "qwen3.8-max",
      "claude-opus-5-5",
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
});
