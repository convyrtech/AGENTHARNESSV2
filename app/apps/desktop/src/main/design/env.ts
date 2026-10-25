/**
 * Pure builders for the design harness process: the pi models.json the stage sessions
 * use, the clean environment `run.py` runs in, and venv paths per platform.
 */
import { join } from "node:path";
import { buildPrsloyModelsJsonProvider } from "../../shared/prsloy-config.ts";

export type StagesConfig = { ladder?: unknown };

/**
 * Provider entry named the way stages.json addresses models (`a6p/<id>`), pointed at the
 * local reliability proxy. Model compat comes from core's PRSLOY catalog (DeepSeek and Kimi
 * answer 400 on tool turns without it); ids the catalog lacks get the provider profile.
 * The proxy holds the real key; pi only sees a placeholder.
 */
export function buildModelsJson(stages: StagesConfig, proxyUrl: string): Record<string, unknown> {
  const ladder = Array.isArray(stages.ladder)
    ? stages.ladder.filter((m): m is string => typeof m === "string" && m.includes("/"))
    : [];
  const providers: Record<string, { ids: string[] }> = {};
  for (const ref of ladder) {
    const [provider, ...rest] = ref.split("/");
    const id = rest.join("/");
    if (!provider || !id) continue;
    (providers[provider] ??= { ids: [] }).ids.push(id);
  }
  const catalog = buildPrsloyModelsJsonProvider(`${proxyUrl.replace(/\/+$/, "")}/v1`);
  const known = new Map((catalog.models as { id: string }[]).map((m) => [m.id, m] as const));
  const out: Record<string, unknown> = {};
  for (const [name, { ids }] of Object.entries(providers)) {
    out[name] = {
      ...catalog,
      apiKey: "local",
      models: ids.map(
        (id) =>
          known.get(id) ?? {
            id,
            name: id,
            reasoning: false,
            input: ["text", "image"],
            contextWindow: 128_000,
            maxTokens: 16_384,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
      ),
    };
  }
  return { providers: out };
}

export function venvBinDir(venv: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? join(venv, "Scripts") : join(venv, "bin");
}

export function venvPython(venv: string, platform: NodeJS.Platform = process.platform): string {
  return join(venvBinDir(venv, platform), platform === "win32" ? "python.exe" : "python");
}

/**
 * `python3` for the agent's shell commands: AGENTS.md says `python3 -I …`; Windows venvs have no python3.
 * `-X utf8`: run.py hands pi an env without PYTHONUTF8 (and `-I` would ignore it), so on Windows the agent's
 * python printed into a cp1252 pipe and died on the first Cyrillic path («Иван Петров») it printed.
 */
export function python3Shims(pythonExe: string): { name: string; body: string; mode?: number }[] {
  const posix = pythonExe.replaceAll("\\", "/");
  return [
    { name: "python3", body: `#!/bin/sh\nexec "${posix}" -X utf8 "$@"\n`, mode: 0o755 },
    { name: "python3.cmd", body: `@"${pythonExe}" -X utf8 %*\r\n` },
  ];
}

const PASS_THROUGH = [
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  // Playwright finds Edge (channel msedge) under Program Files; without these every browser tool failed on Windows
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  // the same non-secret Windows system names run.py's SAFE passes (cmd and Edge misbehave without some of them)
  "SYSTEMDRIVE",
  "PROGRAMDATA",
  "ALLUSERSPROFILE",
  "PUBLIC",
  "HOMEDRIVE",
  "HOMEPATH",
  "USERNAME",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "REQUESTS_CA_BUNDLE",
  "NODE_EXTRA_CA_CERTS",
  "PLAYWRIGHT_BROWSERS_PATH",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
];

export type HarnessEnvInput = {
  base: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** Prepended to PATH in order (shims, venv bin, node dir). */
  pathDirs: string[];
  piBin: string[];
  piAgentDir: string;
  proxyUrl: string;
  /** Playwright channel for Chromium (msedge on Windows). */
  browserChannel?: string;
  chromiumOnly: boolean;
  /** run.py state outside the workspace (HARNESS_STATE_DIR); unset keeps run.py's default. */
  stateDir?: string;
  /** Text-free learning events (HARNESS_LEARN_DIR): the «Код» harness's prsloy-learning folder. */
  learnDir?: string;
};

/**
 * Clean env for `run.py`: no machine secrets (AWS_*, GH_TOKEN, …) reach the harness
 * or the agent; run.py itself narrows it further for pi.
 */
export function buildHarnessEnv(input: HarnessEnvInput): Record<string, string> {
  const env: Record<string, string> = {};
  // Windows env names are case-insensitive (SystemRoot, Path): match on upper case, keep one.
  const win = input.platform === "win32";
  const wanted = new Set(win ? PASS_THROUGH.map((k) => k.toUpperCase()) : PASS_THROUGH);
  const seen = new Set<string>();
  let hostPath = "";
  for (const [key, v] of Object.entries(input.base)) {
    if (typeof v !== "string" || !v) continue;
    const name = win ? key.toUpperCase() : key;
    if (name === "PATH") hostPath = v;
    else if (wanted.has(name) && !seen.has(name)) {
      seen.add(name);
      env[key] = v;
    }
  }
  env.PATH = [...input.pathDirs, hostPath].filter(Boolean).join(win ? ";" : ":");
  env.PI_BIN = JSON.stringify(input.piBin);
  env.PI_CODING_AGENT_DIR = input.piAgentDir;
  env.PI_OFFLINE = "1";
  env.PI_SKIP_VERSION_CHECK = "1";
  env.PI_TELEMETRY = "0";
  env.HARNESS_PROXY = input.proxyUrl;
  env.PYTHONUTF8 = "1";
  env.PYTHONIOENCODING = "utf-8";
  env.PYTHONDONTWRITEBYTECODE = "1";
  if (input.browserChannel) env.DP_BROWSER_CHANNEL = input.browserChannel;
  if (input.chromiumOnly) env.DP_CHROMIUM_ONLY = "1";
  if (input.stateDir) env.HARNESS_STATE_DIR = input.stateDir;
  if (input.learnDir) env.HARNESS_LEARN_DIR = input.learnDir;
  return env;
}
