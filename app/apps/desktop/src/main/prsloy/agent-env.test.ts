import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  BLOCKED_AI_CLIS,
  BLOCKED_CLI_MESSAGE,
  buildPrsloyHostEnv,
  GATEWAY_KEY_HANDOFF_ENV,
  isSecretEnvName,
  prependPath,
  scrubSecretEnv,
  writeAgentShims,
} from "./agent-env.ts";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "prsloy-env-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("secret scrub", () => {
  it("matches the credential name patterns case-insensitively", () => {
    for (const name of [
      "GH_TOKEN",
      "github_token",
      "NPM_TOKEN",
      "OPENAI_API_KEY",
      "Anthropic_Base_Url",
      "AWS_PROFILE",
      "AWS_SECRET_ACCESS_KEY",
      "AZURE_CLIENT_ID",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "STRIPE_SECRET",
      "MY_SERVICE_KEY",
      "DB_PASSWORD",
      "GITHUB_ACTIONS",
    ]) {
      expect(isSecretEnvName(name), name).toBe(true);
    }
    for (const name of [
      "PATH",
      "HOME",
      "HTTPS_PROXY",
      "PI_CODING_AGENT_DIR",
      "KEYBOARD_LAYOUT",
      "TOKENIZERS_PARALLELISM",
      "SystemRoot",
    ]) {
      expect(isSecretEnvName(name), name).toBe(false);
    }
  });

  it("drops secrets and undefined values only", () => {
    expect(
      scrubSecretEnv({
        PATH: "/bin",
        GH_TOKEN: "x",
        OPENAI_API_KEY: "y",
        LANG: "C",
        NOPE: undefined,
      }),
    ).toEqual({ PATH: "/bin", LANG: "C" });
  });
});

describe("PATH prepend", () => {
  it("puts dirs first without duplicates (posix)", () => {
    const env = prependPath({ PATH: "/a:/shims:/b" }, ["/shims"], "linux");
    expect(env.PATH).toBe("/shims:/a:/b");
  });

  it("uses the existing Windows Path key and collapses duplicates", () => {
    const env = prependPath({ Path: "C:\\Win;C:\\Shims", PATH: "stale" }, ["c:\\shims"], "win32");
    expect(env).toEqual({ Path: "c:\\shims;C:\\Win" });
  });
});

describe("host env", () => {
  it("pins pi to the isolated home, scrubs secrets, hands the key last", () => {
    const env = buildPrsloyHostEnv(
      {
        PATH: "/usr/bin",
        GH_TOKEN: "ghp_x",
        AWS_ACCESS_KEY_ID: "a",
        PI_CODING_AGENT_DIR: "/home/u/.pi/agent",
        PRSLOY_GATEWAY_KEY: "stale-from-user-env",
      },
      {
        agentDir: "/ud/agent",
        sessionDir: "/ud/agent/sessions",
        shimsDir: "/ud/agent-shims",
        harnessExtensions: ["/res/prsloy-harness"],
        gatewayKey: "sk-live",
        platform: "linux",
      },
    );
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.PATH).toBe("/ud/agent-shims:/usr/bin");
    expect(env.PI_CODING_AGENT_DIR).toBe("/ud/agent");
    expect(env.PI_CODING_AGENT_SESSION_DIR).toBe("/ud/agent/sessions");
    expect(env.PI_OFFLINE).toBe("1");
    expect(JSON.parse(env.PRSLOY_HARNESS_EXTENSIONS!)).toEqual(["/res/prsloy-harness"]);
    expect(env[GATEWAY_KEY_HANDOFF_ENV]).toBe("sk-live");
  });

  it("omits the key handoff when there is no key", () => {
    const env = buildPrsloyHostEnv(
      { PATH: "/usr/bin", PRSLOY_GATEWAY_KEY: "leak" },
      { agentDir: "/a", sessionDir: "/s", shimsDir: "/sh", platform: "linux" },
    );
    expect(env[GATEWAY_KEY_HANDOFF_ENV]).toBeUndefined();
  });
});

describe.skipIf(process.platform === "win32")("shims (real shell)", () => {
  it("blocks other AI CLIs and routes python3/python to the bundled interpreter", () => {
    const shimsDir = tempDir();
    const python = execFileSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).trim();
    writeAgentShims({ shimsDir, pythonExecutable: python, platform: "linux" });
    const env = buildPrsloyHostEnv(
      { PATH: process.env.PATH, HOME: process.env.HOME, GH_TOKEN: "ghp_secret" },
      { agentDir: "/a", sessionDir: "/s", shimsDir, platform: "linux" },
    );
    for (const cli of BLOCKED_AI_CLIS) {
      const result = spawnSync("bash", ["-c", `${cli} --version`], { env, encoding: "utf8" });
      expect(result.status, cli).toBe(126);
      expect(result.stderr.trim()).toBe(BLOCKED_CLI_MESSAGE);
    }
    const py = spawnSync("bash", ["-c", "python -c 'import sys; print(sys.version_info[0])'"], {
      env,
      encoding: "utf8",
    });
    expect(py.stdout.trim()).toBe("3");
    const leaked = spawnSync("bash", ["-c", "env"], { env, encoding: "utf8" });
    expect(leaked.stdout).not.toContain("ghp_secret");
  });

  it("writes .cmd twins on Windows layouts", () => {
    const shimsDir = tempDir();
    const written = writeAgentShims({
      shimsDir,
      pythonExecutable: "C:\\Users\\u\\AppData\\Roaming\\PRSLOY\\runtimes\\python\\python.exe",
      platform: "win32",
    });
    expect(written.some((p) => p.endsWith("claude.cmd"))).toBe(true);
    expect(readFileSync(join(shimsDir, "python3"), "utf8")).toContain(
      "C:/Users/u/AppData/Roaming/PRSLOY/runtimes/python/python.exe",
    );
    expect(readFileSync(join(shimsDir, "python3.cmd"), "utf8")).toContain(
      '"C:\\Users\\u\\AppData\\Roaming\\PRSLOY\\runtimes\\python\\python.exe" %*',
    );
  });
});
