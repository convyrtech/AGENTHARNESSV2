// @vitest-environment jsdom
import { describe, expect, it } from "vite-plus/test";
import type { PrsloyState } from "@zeno/contracts";
import {
  cleanPastedKey,
  firstRunStep,
  gatewayErrorKey,
  appSetupPercent,
  FIRST_RUN_SEEN_KEYS,
  markFirstRunSeen,
  readFirstRunSeen,
} from "./prsloy-first-run.ts";
import { t } from "./i18n.ts";
import { SEARCH_READY } from "../../shared/search-ready.ts";

const base: PrsloyState = {
  hasKey: false,
  keyMemoryOnly: false,
  maskedKey: "",
  baseUrl: "https://api.prsloy.online/v1",
  defaultBaseUrl: "https://api.prsloy.online/v1",
  needsWorkspace: true,
  harnessLoaded: false,
  firstRunBypass: false,
  gitSetup: { status: "absent" },
};

describe("prsloy first run", () => {
  it("asks for the key, then import and search, then the folder, then gets out of the way", () => {
    const seen = { import: true, search: true };
    expect(firstRunStep(undefined)).toBe("loading");
    expect(firstRunStep(base)).toBe("key");
    expect(firstRunStep({ ...base, hasKey: true })).toBe("import");
    expect(firstRunStep({ ...base, hasKey: true }, { import: true }, true)).toBe("search");
    expect(firstRunStep({ ...base, hasKey: true }, seen)).toBe("folder");
    expect(firstRunStep({ ...base, hasKey: true, needsWorkspace: false }, seen)).toBe("done");
    expect(firstRunStep({ ...base, firstRunBypass: true })).toBe("done");
  });

  it("skips the search step until SEARCH_READY (#23)", () => {
    // RC check (desktop/ui-rc): search is shown to everyone
    expect(SEARCH_READY).toBe(true);
    expect(firstRunStep({ ...base, hasKey: true }, { import: true })).toBe("search");
    expect(firstRunStep({ ...base, hasKey: true }, { import: true }, false)).toBe("folder");
  });

  it("does not stop people who already have a project with the optional steps", () => {
    expect(firstRunStep({ ...base, hasKey: true, needsWorkspace: false })).toBe("done");
  });

  it("remembers passed optional steps", () => {
    localStorage.removeItem(FIRST_RUN_SEEN_KEYS.import);
    localStorage.removeItem(FIRST_RUN_SEEN_KEYS.search);
    expect(readFirstRunSeen()).toEqual({});
    markFirstRunSeen("import");
    expect(readFirstRunSeen()).toEqual({ import: true });
    expect(localStorage.getItem("prsloy.firstRun.importSeen")).toBe("1");
    markFirstRunSeen("search");
    expect(readFirstRunSeen()).toEqual({ import: true, search: true });
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

  it("shows git setup progress only while installing", () => {
    expect(appSetupPercent(base)).toBeUndefined();
    expect(appSetupPercent({ ...base, gitSetup: { status: "installing", percent: 42 } })).toBe(
      "42",
    );
    expect(appSetupPercent({ ...base, gitSetup: { status: "installing" } })).toBe("0");
    expect(
      appSetupPercent({
        ...base,
        gitSetup: { status: "installing", percent: 90 },
        appSetup: { status: "installing", percent: 7 },
      }),
    ).toBe("7");
    expect(appSetupPercent({ ...base, appSetup: { status: "ready" } })).toBeUndefined();
  });

  it("cleans pasted keys", () => {
    expect(cleanPastedKey(" sk-ab​cd\n")).toBe("sk-abcd");
  });
});
