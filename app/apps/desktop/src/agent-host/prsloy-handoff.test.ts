import { describe, expect, it } from "vite-plus/test";
import { takePrsloyHandoff } from "./prsloy-handoff.ts";

describe("prsloy handoff", () => {
  it("takes the key and removes it from the env", () => {
    const env: NodeJS.ProcessEnv = {
      PRSLOY_GATEWAY_KEY: " sk-live ",
      PRSLOY_HARNESS_EXTENSIONS: JSON.stringify(["/res/prsloy-harness", "", 3]),
      PATH: "/bin",
    };
    expect(takePrsloyHandoff(env)).toEqual({
      gatewayKey: "sk-live",
      harnessExtensions: ["/res/prsloy-harness"],
    });
    expect(env.PRSLOY_GATEWAY_KEY).toBeUndefined();
    expect(env.PATH).toBe("/bin");
  });

  it("tolerates missing or malformed values", () => {
    expect(takePrsloyHandoff({ PRSLOY_HARNESS_EXTENSIONS: "{nope" })).toEqual({
      harnessExtensions: [],
    });
    expect(takePrsloyHandoff({})).toEqual({ harnessExtensions: [] });
  });
});
