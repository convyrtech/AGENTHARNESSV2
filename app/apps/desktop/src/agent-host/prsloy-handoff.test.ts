import { describe, expect, it } from "vite-plus/test";
import { HOST_HANDOFF_TYPE, isHostHandoff } from "../shared/host-handoff.ts";
import { applyHostHandoff, takePrsloyHandoff } from "./prsloy-handoff.ts";

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

  it("the parentPort message sets the key and the search config", () => {
    const target = takePrsloyHandoff({});
    const message = {
      type: HOST_HANDOFF_TYPE,
      gatewayKey: " sk-msg ",
      search: { search: { provider: "free" } },
    } as const;
    expect(isHostHandoff(message)).toBe(true);
    applyHostHandoff(target, message);
    expect(target).toMatchObject({
      gatewayKey: "sk-msg",
      search: { search: { provider: "free" } },
    });
    // Junk is not a handoff (and not a command either).
    expect(isHostHandoff({ type: HOST_HANDOFF_TYPE, gatewayKey: 42 })).toBe(false);
    expect(isHostHandoff({ type: HOST_HANDOFF_TYPE, search: { search: {} } })).toBe(false);
    expect(isHostHandoff({ type: "host.start" })).toBe(false);
  });
});
