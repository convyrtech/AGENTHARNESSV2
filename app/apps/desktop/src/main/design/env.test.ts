import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { buildHarnessEnv, buildModelsJson, python3Shims, venvBinDir, venvPython } from "./env.ts";

const STAGES = join(import.meta.dirname, "../../../../../../playbooks/site/harness/stages.json");

describe("buildModelsJson", () => {
  it("names the provider the way stages.json addresses models and points it at the proxy", () => {
    const stages = JSON.parse(readFileSync(STAGES, "utf8")) as { ladder: string[] };
    const json = buildModelsJson(stages, "http://127.0.0.1:41234/") as {
      providers: Record<string, { baseUrl: string; apiKey: string; models: { id: string }[] }>;
    };
    const providers = Object.keys(json.providers);
    expect(providers).toEqual([...new Set(stages.ladder.map((m) => m.split("/")[0]))]);
    const p = json.providers[providers[0]!]!;
    expect(p.baseUrl).toBe("http://127.0.0.1:41234/v1");
    expect(p.apiKey).toBe("local");
    expect(stages.ladder.map((m) => m.split("/").slice(1).join("/"))).toEqual(
      p.models.map((m) => m.id),
    );
  });

  it("ignores malformed ladders", () => {
    expect(buildModelsJson({ ladder: ["bare", 3] }, "http://x")).toEqual({ providers: {} });
    expect(buildModelsJson({}, "http://x")).toEqual({ providers: {} });
  });
});

describe("buildHarnessEnv", () => {
  const input = {
    platform: "linux" as NodeJS.Platform,
    pathDirs: ["/shims", "/venv/bin"],
    piBin: ["/node", "/pi/cli.js"],
    piAgentDir: "/ud/design/pi-agent",
    proxyUrl: "http://127.0.0.1:5",
    browserChannel: "msedge",
    chromiumOnly: true,
  };

  it("keeps only the allow-list: machine secrets never reach the harness", () => {
    const env = buildHarnessEnv({
      ...input,
      base: {
        PATH: "/usr/bin",
        HOME: "/h",
        AWS_SECRET_ACCESS_KEY: "x",
        GH_TOKEN: "x",
        OPENAI_API_KEY: "x",
        PRSLOY_API_KEY: "x",
        https_proxy: "http://p:1",
      },
    });
    expect(env).toEqual({
      PATH: "/shims:/venv/bin:/usr/bin",
      HOME: "/h",
      https_proxy: "http://p:1",
      PI_BIN: '["/node","/pi/cli.js"]',
      PI_CODING_AGENT_DIR: "/ud/design/pi-agent",
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      HARNESS_PROXY: "http://127.0.0.1:5",
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
      PYTHONDONTWRITEBYTECODE: "1",
      DP_BROWSER_CHANNEL: "msedge",
      DP_CHROMIUM_ONLY: "1",
    });
  });

  it("on Windows matches names case-insensitively and keeps one PATH", () => {
    const env = buildHarnessEnv({
      ...input,
      platform: "win32",
      pathDirs: ["C:\\shims"],
      base: { Path: "C:\\Windows", SystemRoot: "C:\\Windows", SYSTEMROOT: "C:\\Windows" },
    });
    expect(env.PATH).toBe("C:\\shims;C:\\Windows");
    expect(Object.keys(env).filter((k) => k.toUpperCase() === "SYSTEMROOT")).toHaveLength(1);
    expect(Object.keys(env).filter((k) => k.toUpperCase() === "PATH")).toEqual(["PATH"]);
  });
});

describe("venv layout", () => {
  it("uses Scripts\\python.exe on Windows and bin/python elsewhere", () => {
    expect(venvBinDir("/v", "linux")).toBe(join("/v", "bin"));
    expect(venvPython("/v", "win32")).toBe(join("/v", "Scripts", "python.exe"));
  });

  it("gives the agent a python3 for both shells", () => {
    const shims = python3Shims("C:\\ud\\venv\\Scripts\\python.exe");
    expect(shims.map((s) => s.name)).toEqual(["python3", "python3.cmd"]);
    expect(shims[0]!.body).toContain('exec "C:/ud/venv/Scripts/python.exe" "$@"');
    expect(shims[1]!.body).toBe('@"C:\\ud\\venv\\Scripts\\python.exe" %*\r\n');
  });
});
