import { describe, expect, it } from "vite-plus/test";
import { HTTP_IDLE_TIMEOUT_PRESETS, httpIdleTimeoutOptions } from "./http-idle-timeout.ts";

const tr = (key: string, vars?: Record<string, string>) =>
  vars ? `${key}:${JSON.stringify(vars)}` : key;

describe("httpIdleTimeoutOptions", () => {
  it("lists the presets", () => {
    const options = httpIdleTimeoutOptions(tr, undefined);
    expect(options).toHaveLength(HTTP_IDLE_TIMEOUT_PRESETS.length);
    expect(options[0]).toEqual({ value: "30000", label: "piSettings.httpIdle30s" });
  });

  it("puts a value outside the presets first so the select can show it", () => {
    expect(httpIdleTimeoutOptions(tr, 45_000)[0]).toEqual({
      value: "45000",
      label: 'piSettings.httpIdleCustom:{"seconds":"45"}',
    });
    expect(httpIdleTimeoutOptions(tr, 60_000)).toHaveLength(HTTP_IDLE_TIMEOUT_PRESETS.length);
    expect(httpIdleTimeoutOptions(tr, Number.NaN)).toHaveLength(HTTP_IDLE_TIMEOUT_PRESETS.length);
  });
});
