import { describe, expect, it } from "vite-plus/test";
import { takePrsloyHandoff } from "./prsloy-handoff.ts";

describe("prsloy handoff", () => {
  it("takes the key and removes it from the env", () => {
    const env: NodeJS.ProcessEnv = { PRSLOY_GATEWAY_KEY: " sk-live ", PATH: "/bin" };
    expect(takePrsloyHandoff(env)).toEqual({ gatewayKey: "sk-live", harnessEnabled: true });
    expect(env.PRSLOY_GATEWAY_KEY).toBeUndefined();
    expect(env.PATH).toBe("/bin");
  });

  it("has no key without the handoff var and honours PRSLOY_HARNESS=0", () => {
    expect(takePrsloyHandoff({})).toEqual({ harnessEnabled: true });
    expect(takePrsloyHandoff({ PRSLOY_HARNESS: "0" })).toEqual({ harnessEnabled: false });
  });
});
