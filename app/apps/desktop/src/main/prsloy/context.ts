/**
 * PRSLOY main-process context: computed once at startup (before any Agent Host spawn),
 * then used by the host env builder, the per-turn snapshots and the PRSLOY IPC.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { normalizePrsloyBaseUrl, PRSLOY_DEFAULT_BASE_URL } from "../../shared/prsloy-config.ts";
import { buildPrsloyHostEnv, writeAgentShims } from "./agent-env.ts";
import {
  ensurePrsloyHomeDirs,
  ensurePrsloyModelsJson,
  ensurePrsloySettings,
  installSearchTools,
  prsloyHomePaths,
  resolvePrsloyAgentDir,
  type PrsloyHomePaths,
} from "./agent-home.ts";
import { PrsloyKeyStore, type SecretCipher } from "./key-store.ts";
import { TurnSnapshots } from "./turn-snapshots.ts";
import { chooseGitBinary, chooseWindowsShellPath } from "./windows-shell.ts";

export type PrsloyState = { baseUrl: string };

export type PrsloyContext = {
  paths: PrsloyHomePaths;
  agentDir: string;
  sessionDir: string;
  /** prsloy-harness extensions run in every session (bundled into the host). */
  harnessEnabled: boolean;
  /** Windows only: what pi's bash tool runs. */
  shellPath?: string;
  shellSource?: "bundled" | "system" | "missing";
  gitBinary: string;
  keyStore: PrsloyKeyStore;
  snapshots: TurnSnapshots;
  getState(): PrsloyState;
  /** Persist + rewrite models.json. Returns the normalized URL. */
  setBaseUrl(raw: string): string;
  /** Agent Host env: scrubbed, shims first, pinned home, key handoff. */
  hostEnv(base: Record<string, string | undefined>): Record<string, string>;
};

function readState(path: string): PrsloyState {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PrsloyState>;
    const baseUrl = normalizePrsloyBaseUrl(parsed.baseUrl);
    if (baseUrl) return { baseUrl };
  } catch {
    // fall through to defaults
  }
  return { baseUrl: PRSLOY_DEFAULT_BASE_URL };
}

function writeState(path: string, state: PrsloyState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

/** venv interpreter if present, else the bundled one. */
export function pickPythonExecutable(options: {
  platform: NodeJS.Platform;
  pythonVenv?: string | undefined;
  bundledPython?: string | undefined;
  exists?: (path: string) => boolean;
}): string | undefined {
  const exists = options.exists ?? existsSync;
  if (options.pythonVenv) {
    const venvPy =
      options.platform === "win32"
        ? join(options.pythonVenv, "Scripts", "python.exe")
        : join(options.pythonVenv, "bin", "python3");
    if (exists(venvPy)) return venvPy;
  }
  return options.bundledPython && exists(options.bundledPython) ? options.bundledPython : undefined;
}

export function bootstrapPrsloy(options: {
  userDataPath: string;
  resourcesPath?: string | undefined;
  mainModuleUrl?: string | undefined;
  /** Root holding provisioned runtimes (node/, python/, git/). */
  runtimesRoot?: string | undefined;
  pythonExecutable?: string | undefined;
  cipher: SecretCipher;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): PrsloyContext {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const paths = prsloyHomePaths(options.userDataPath);
  const agentDir = resolvePrsloyAgentDir(options.userDataPath, env);
  const sessionDir = join(agentDir, "sessions");
  ensurePrsloyHomeDirs(paths, agentDir);
  mkdirSync(sessionDir, { recursive: true });

  // Everything in this process that asks pi for its home (TUI, package manager,
  // defaultAgentDir()) now resolves to the isolated dir.
  env.PI_CODING_AGENT_DIR = agentDir;
  env.PI_CODING_AGENT_SESSION_DIR = sessionDir;

  const statePath = join(paths.stateDir, "state.json");
  let state = readState(statePath);

  const runtimesRoot = options.runtimesRoot ?? join(options.userDataPath, "runtimes");
  const bundledGitRoot = join(runtimesRoot, "git");
  installSearchTools(join(runtimesRoot, "tools"), agentDir);
  let shellPath: string | undefined;
  let shellSource: PrsloyContext["shellSource"];
  if (platform === "win32") {
    const chosen = chooseWindowsShellPath({ bundledGitRoot, env });
    shellPath = chosen.shellPath;
    shellSource = chosen.source;
  }
  const gitBinary = chooseGitBinary({ platform, bundledGitRoot, env });

  ensurePrsloyModelsJson(agentDir, state.baseUrl);
  ensurePrsloySettings(agentDir, { shellPath });
  try {
    writeAgentShims({
      shimsDir: paths.shimsDir,
      pythonExecutable: options.pythonExecutable,
      platform,
    });
  } catch (error) {
    console.warn("[prsloy] writing agent shims failed:", error);
  }

  const harnessEnabled = env.PRSLOY_HARNESS !== "0";
  const keyStore = new PrsloyKeyStore(join(paths.stateDir, "gateway-key.bin"), options.cipher);
  const snapshots = new TurnSnapshots({ root: paths.snapshotsDir, gitBinary, platform });

  return {
    paths,
    agentDir,
    sessionDir,
    harnessEnabled,
    ...(shellPath ? { shellPath } : {}),
    ...(shellSource ? { shellSource } : {}),
    gitBinary,
    keyStore,
    snapshots,
    getState: () => ({ ...state }),
    setBaseUrl(raw) {
      const baseUrl = normalizePrsloyBaseUrl(raw);
      if (!baseUrl) throw new Error("Invalid gateway URL");
      state = { ...state, baseUrl };
      writeState(statePath, state);
      ensurePrsloyModelsJson(agentDir, baseUrl);
      return baseUrl;
    },
    hostEnv(base) {
      return buildPrsloyHostEnv(base, {
        agentDir,
        sessionDir,
        shimsDir: paths.shimsDir,
        gatewayKey: keyStore.read(),
        platform,
      });
    },
  };
}
