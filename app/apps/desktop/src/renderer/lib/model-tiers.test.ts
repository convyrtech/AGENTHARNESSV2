import { describe, expect, it } from "vite-plus/test";
import { MODEL_TIER_PROVIDER, MODEL_TIERS, modelForTier, tierForModel } from "./model-tiers.ts";

describe("model tiers", () => {
  it("maps fast and quality to the agreed model ids", () => {
    expect(MODEL_TIERS).toEqual({ fast: "deepseek-v4.1-flash-1017", quality: "kimi-k3.1-pro" });
  });

  it("reads the tier of the active model", () => {
    expect(tierForModel("prsloy/deepseek-v4.1-flash-1017")).toBe("fast");
    expect(tierForModel("other/kimi-k3.1-pro")).toBe("quality");
    expect(tierForModel("prsloy/something-else")).toBeUndefined();
    expect(tierForModel("")).toBeUndefined();
  });

  it("prefers the PRSLOY provider's entry for a tier", () => {
    const options = [
      { provider: "openrouter", id: "kimi-k3.1-pro" },
      { provider: MODEL_TIER_PROVIDER, id: "kimi-k3.1-pro" },
    ];
    expect(modelForTier("quality", options)).toEqual(options[1]);
    expect(modelForTier("quality", [options[0]!])).toEqual(options[0]);
  });

  it("follows what the gateway serves: no DeepSeek / Kimi → GPT-6.1 Sol, never Qwen or Grok", () => {
    const served = ["qwen3.8-max", "claude-opus-5-5", "grok-4.7", "gpt-6.1-sol"].map((id) => ({
      provider: MODEL_TIER_PROVIDER,
      id,
    }));
    expect(modelForTier("fast", served).id).toBe("gpt-6.1-sol");
    expect(modelForTier("quality", served).id).toBe("gpt-6.1-sol");
    expect(tierForModel("prsloy/gpt-6.1-sol", served)).toBe("fast");
    expect(tierForModel("prsloy/qwen3.8-max", served)).toBeUndefined();
    expect(tierForModel("prsloy/grok-4.7", served)).toBeUndefined();
  });

  it("falls back to the PRSLOY provider when the host does not list the model", () => {
    expect(modelForTier("fast", [])).toEqual({
      provider: MODEL_TIER_PROVIDER,
      id: "deepseek-v4.1-flash-1017",
    });
  });
});
