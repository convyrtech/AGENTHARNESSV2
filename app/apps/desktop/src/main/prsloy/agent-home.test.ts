import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  disablePrsloyComputerUseConfig,
  ensurePrsloyHomeDirs,
  ensurePrsloyModelsJson,
  ensurePrsloySettings,
  installSearchTools,
  prsloyHomePaths,
  resolvePrsloyAgentDir,
} from "./agent-home.ts";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "prsloy-home-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;

describe("agent home paths", () => {
  it("lives under userData, never ~/.pi", () => {
    const paths = prsloyHomePaths("/ud");
    expect(paths.agentDir).toBe(join("/ud", "agent"));
    expect(paths.sessionDir).toBe(join("/ud", "agent", "sessions"));
    expect(resolvePrsloyAgentDir("/ud", { PI_CODING_AGENT_DIR: "/home/u/.pi/agent" })).toBe(
      join("/ud", "agent"),
    );
  });

  it("lets test harnesses pin an isolated dir", () => {
    expect(
      resolvePrsloyAgentDir("/ud", {
        PI_CODING_AGENT_DIR: "/tmp/e2e-agent",
        ZENO_ENABLE_TEST_COMMANDS: "1",
      }),
    ).toBe("/tmp/e2e-agent");
  });

  it("creates every directory", () => {
    const root = tempDir();
    const paths = prsloyHomePaths(root);
    ensurePrsloyHomeDirs(paths);
    for (const dir of Object.values(paths)) expect(existsSync(dir)).toBe(true);
  });
});

describe("models.json seed", () => {
  it("adds the keyless prsloy provider and keeps developer providers", () => {
    const agentDir = tempDir();
    writeFileSync(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: { mine: { baseUrl: "http://x/v1", api: "openai-completions" } },
      }),
    );
    expect(ensurePrsloyModelsJson(agentDir, "https://gw.example/v1")).toBe(true);
    const models = readJson(join(agentDir, "models.json"));
    expect(Object.keys(models.providers)).toEqual(["mine", "prsloy"]);
    expect(models.providers.prsloy.baseUrl).toBe("https://gw.example/v1");
    expect(models.providers.prsloy.apiKey).toBeUndefined();
    expect(ensurePrsloyModelsJson(agentDir, "https://gw.example/v1")).toBe(false);
    expect(ensurePrsloyModelsJson(agentDir, "https://other/v1")).toBe(true);
    expect(readJson(join(agentDir, "models.json")).providers.prsloy.baseUrl).toBe(
      "https://other/v1",
    );
  });

  it("recovers from a corrupt models.json", () => {
    const agentDir = tempDir();
    writeFileSync(join(agentDir, "models.json"), "{ nope");
    ensurePrsloyModelsJson(agentDir, "https://gw/v1");
    expect(readJson(join(agentDir, "models.json")).providers.prsloy).toBeDefined();
    expect(readdirSync(agentDir).some((n) => n.startsWith("models.json.corrupt-"))).toBe(true);
  });
});

describe("settings.json seed", () => {
  it("defaults to the fast PRSLOY model and enforces shellPath", () => {
    const agentDir = tempDir();
    ensurePrsloySettings(agentDir, { shellPath: "C:\\PRSLOY\\git\\bin\\bash.exe" });
    const settings = readJson(join(agentDir, "settings.json"));
    expect(settings.defaultProvider).toBe("prsloy");
    expect(settings.defaultModel).toBe("deepseek-v4.1-flash-1017");
    expect(settings.shellPath).toBe("C:\\PRSLOY\\git\\bin\\bash.exe");
  });

  it("keeps a user's model choice, drops powershell and stale shellPath", () => {
    const agentDir = tempDir();
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({
        defaultProvider: "prsloy",
        defaultModel: "kimi-k3.1-pro",
        shellPath: "C:\\Windows\\System32\\bash.exe",
        defaultTools: ["read", "bash", "powershell"],
      }),
    );
    ensurePrsloySettings(agentDir, {});
    const settings = readJson(join(agentDir, "settings.json"));
    expect(settings.defaultModel).toBe("kimi-k3.1-pro");
    expect(settings.shellPath).toBeUndefined();
    expect(settings.defaultTools).toEqual(["read", "bash"]);
  });
});

describe("MCP off by default", () => {
  it("seeds built-in MCP off only when no user extension list exists", () => {
    const agentDir = tempDir();
    ensurePrsloySettings(agentDir, { computerUse: true });
    ensurePrsloySettings(agentDir, { computerUse: false });
    expect(readJson(join(agentDir, "settings.json")).extensions).toContain("-builtin:mcp");

    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ extensions: ["+builtin:mcp", "custom"] }),
    );
    ensurePrsloySettings(agentDir, { computerUse: true });
    ensurePrsloySettings(agentDir, { computerUse: false });
    expect(readJson(join(agentDir, "settings.json")).extensions).toEqual([
      "+builtin:mcp",
      "custom",
    ]);
  });
  it("keeps an existing built-in choice unchanged and disables only the owned server on opt-out", () => {
    const agentDir = tempDir();
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ extensions: ["+builtin:mcp", "custom"] }),
    );
    writeFileSync(
      join(agentDir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          munimComputerUse: {
            command: "C:\\Tools\\munim-computer-use.exe",
            args: [],
            exposure: "direct",
            prsloyComputerUseOwned: true,
            disabled: false,
            enabled: true,
          },
        },
      }),
    );
    ensurePrsloySettings(agentDir, { computerUse: false });
    disablePrsloyComputerUseConfig(agentDir);
    expect(readJson(join(agentDir, "settings.json")).extensions).toEqual([
      "+builtin:mcp",
      "custom",
    ]);
    expect(readJson(join(agentDir, "mcp.json")).mcpServers.munimComputerUse).toMatchObject({
      enabled: false,
      disabled: true,
    });
  });
  it("removes the legacy restore marker without rewriting the current user extensions", () => {
    const agentDir = tempDir();
    const extensions = ["custom", "-builtin:mcp"];
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ extensions, prsloyRestoreBuiltinMcp: true }),
    );
    ensurePrsloySettings(agentDir, { computerUse: true });
    const optedIn = readJson(join(agentDir, "settings.json"));
    expect(optedIn.extensions).toEqual(extensions);
    expect(optedIn.prsloyRestoreBuiltinMcp).toBeUndefined();

    ensurePrsloySettings(agentDir, { computerUse: false });
    expect(readJson(join(agentDir, "settings.json")).extensions).toEqual(extensions);
  });
  it("leaves an unrelated user-managed server with the same name alone on opt-out", () => {
    const agentDir = tempDir();
    const other = { command: "custom.exe", args: ["serve"] };
    writeFileSync(
      join(agentDir, "mcp.json"),
      JSON.stringify({ mcpServers: { munimComputerUse: other } }),
    );
    expect(disablePrsloyComputerUseConfig(agentDir)).toBe(false);
    expect(readJson(join(agentDir, "mcp.json")).mcpServers.munimComputerUse).toEqual(other);
  });
  it("preserves a user-managed Munim even when it looks like the old experimental config", () => {
    const agentDir = tempDir();
    const manual = {
      command: "C:\\Tools\\munim-computer-use.exe",
      args: [],
      env: { COMPUTER_USE_BROWSER: "0" },
    };
    writeFileSync(
      join(agentDir, "mcp.json"),
      JSON.stringify({ mcpServers: { munimComputerUse: manual } }),
    );
    expect(disablePrsloyComputerUseConfig(agentDir)).toBe(false);
    expect(readJson(join(agentDir, "mcp.json")).mcpServers.munimComputerUse).toEqual(manual);
  });
  it("seeds -builtin:mcp unless the user has an extensions list", () => {
    const agentDir = tempDir();
    ensurePrsloySettings(agentDir, {});
    expect(readJson(join(agentDir, "settings.json")).extensions).toEqual(["-builtin:mcp"]);
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ extensions: ["+builtin:mcp"] }),
    );
    ensurePrsloySettings(agentDir, {});
    expect(readJson(join(agentDir, "settings.json")).extensions).toEqual(["+builtin:mcp"]);
  });

  it("retires a persisted PRSLOY-owned Munim entry without modifying other MCP servers", () => {
    const agentDir = tempDir();
    const userServer = { command: "custom.exe", args: ["serve"] };
    writeFileSync(
      join(agentDir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          munimComputerUse: {
            command: "C:\\Tools\\munim-computer-use.exe",
            args: [],
            exposure: "direct",
            prsloyComputerUseOwned: true,
            enabled: true,
          },
          custom: userServer,
        },
      }),
    );
    expect(disablePrsloyComputerUseConfig(agentDir)).toBe(true);
    const servers = readJson(join(agentDir, "mcp.json")).mcpServers;
    expect(servers.munimComputerUse).toMatchObject({ enabled: false, disabled: true });
    expect(servers.custom).toEqual(userServer);
  });

  it("drops the auto-installed npm:pi-mcp-adapter once, keeps other packages", () => {
    const agentDir = tempDir();
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({
        packages: ["npm:pi-mcp-adapter", { source: "npm:pi-mcp-adapter" }, "npm:other-pkg"],
      }),
    );
    ensurePrsloySettings(agentDir, { dropAutoMcpAdapter: true });
    expect(readJson(join(agentDir, "settings.json")).packages).toEqual(["npm:other-pkg"]);
    // Without the migration flag a developer's own choice is left alone.
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ packages: ["npm:pi-mcp-adapter"] }),
    );
    ensurePrsloySettings(agentDir, {});
    expect(readJson(join(agentDir, "settings.json")).packages).toEqual(["npm:pi-mcp-adapter"]);
  });
});

describe("bundled search tools", () => {
  it("copies rg/fd into agentDir/bin and ignores other files", () => {
    const tools = tempDir();
    const agentDir = tempDir();
    writeFileSync(join(tools, "rg.exe"), "rg-binary");
    writeFileSync(join(tools, "fd.exe"), "fd-binary");
    writeFileSync(join(tools, "evil.exe"), "nope");
    expect(installSearchTools(tools, agentDir).sort()).toEqual(["fd.exe", "rg.exe"]);
    expect(readFileSync(join(agentDir, "bin", "rg.exe"), "utf8")).toBe("rg-binary");
    expect(existsSync(join(agentDir, "bin", "evil.exe"))).toBe(false);
    expect(installSearchTools(join(tools, "missing"), agentDir)).toEqual([]);
  });
});
