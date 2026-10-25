import { describe, expect, it } from "vite-plus/test";
import type { PrsloyState } from "@zeno/contracts";
import { cleanPastedKey, firstRunStep, gatewayErrorKey } from "./prsloy-first-run.ts";
import { t } from "./i18n.ts";

const base: PrsloyState = {
  hasKey: false,
  keyMemoryOnly: false,
  maskedKey: "",
  baseUrl: "https://api.prsloy.online/v1",
  defaultBaseUrl: "https://api.prsloy.online/v1",
  needsWorkspace: true,
  harnessLoaded: false,
  firstRunBypass: false,
};

describe("prsloy first run", () => {
  it("asks for the key, then the folder, then gets out of the way", () => {
    expect(firstRunStep(undefined)).toBe("loading");
    expect(firstRunStep(base)).toBe("key");
    expect(firstRunStep({ ...base, hasKey: true })).toBe("folder");
    expect(firstRunStep({ ...base, hasKey: true, needsWorkspace: false })).toBe("done");
    expect(firstRunStep({ ...base, firstRunBypass: true })).toBe("done");
  });

  it("maps every gateway error to a translated message", () => {
    for (const code of [
      "invalid_key",
      "no_balance",
      "network",
      "timeout",
      "server",
      "bad_url",
    ] as const) {
      const key = gatewayErrorKey(code);
      expect(t("en", key)).not.toBe(key);
      expect(t("zh", key)).not.toBe(key);
    }
    expect(gatewayErrorKey(undefined)).toBe("prsloy.error.server");
  });

  it("cleans pasted keys", () => {
    expect(cleanPastedKey(" sk-ab​cd\n")).toBe("sk-abcd");
  });
});
