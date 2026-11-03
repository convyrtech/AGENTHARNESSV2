import { resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  allowedCuaConfig,
  allowedMunimConfig,
  selectComputerUseBackend,
} from "./computer-use-mcp.ts";

describe("computer-use MCP selection", () => {
  const binary = resolve("munim-computer-use.exe");
  const config = {
    command: binary,
    args: [],
    exposure: "direct",
    toolExposure: { run_steps: "direct" },
  };
  it("requires a matching absolute binary and respects disabled configs", () => {
    for (const [value, path] of [
      [config, undefined],
      [config, "relative.exe"],
      [config, resolve("other.exe")],
      [{ ...config, disabled: true }, binary],
      [{ ...config, enabled: false }, binary],
      ["bad", binary],
    ] as const) {
      expect(allowedMunimConfig(value, path)).toBeUndefined();
    }
  });
  it("replaces untrusted exposure overrides with the guarded allowlist", () => {
    const allowed = allowedMunimConfig(
      {
        ...config,
        url: "https://unexpected.example/mcp",
        args: ["--unexpected"],
        env: { UNEXPECTED: "1" },
      },
      binary,
    );
    expect(allowed?.exposure).toBe("hidden");
    expect(allowed).toMatchObject({
      command: binary,
      args: [],
      env: { COMPUTER_USE_BROWSER: "0" },
    });
    expect(allowed).not.toHaveProperty("url");
    expect(allowed?.toolExposure).toMatchObject({
      list_apps: "codemode",
      get_app_state: "codemode",
      type_text: "codemode",
      click: "codemode",
      screenshot: "codemode",
    });
    expect(allowed?.toolExposure?.run_steps).toBeUndefined();
  });
  it("selects an absolute Cua binary with only the direct mcp --direct allowlist", () => {
    const cuaBinary = resolve("cua-driver.exe");
    const allowed = allowedCuaConfig(
      { command: cuaBinary, args: ["serve"], exposure: "direct" },
      cuaBinary,
    );
    expect(allowed).toMatchObject({
      command: cuaBinary,
      args: ["mcp", "--direct"],
      exposure: "hidden",
      toolExposure: {
        list_apps: "codemode",
        list_windows: "codemode",
        get_window_state: "codemode",
        click: "codemode",
        type_text: "codemode",
      },
    });
    expect(Object.keys(allowed?.toolExposure ?? {}).sort()).toEqual([
      "click",
      "get_window_state",
      "list_apps",
      "list_windows",
      "type_text",
    ]);
    expect(allowedCuaConfig({ command: "cua-driver.exe" }, "cua-driver.exe")).toBeUndefined();
    expect(allowedCuaConfig({ command: cuaBinary, disabled: true }, cuaBinary)).toBeUndefined();
  });
  it("is off by default, preserves Munim, and prefers explicit Cua without fallback", () => {
    expect(selectComputerUseBackend(false, undefined)).toBeUndefined();
    expect(selectComputerUseBackend(false, resolve("cua-driver.exe"))).toBeUndefined();
    expect(selectComputerUseBackend(true, undefined)).toBe("munim");
    expect(selectComputerUseBackend(true, resolve("cua-driver.exe"))).toBe("cua");
    // An invalid explicit Cua path must fail closed instead of silently switching backends.
    expect(allowedCuaConfig({ command: "relative.exe" }, "relative.exe")).toBeUndefined();
  });
});
