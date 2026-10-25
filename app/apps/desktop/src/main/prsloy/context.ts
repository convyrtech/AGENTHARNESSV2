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
import { restrictToCurrentUser } from "./file-acl.ts";
import { GitRuntime, isInstallerGit, type GitSetupState } from "./runtime-git.ts";
import { TurnSnapshots } from "./turn-snapshots.ts";
import { chooseGitBinary, chooseWindowsShellPath } from "./windows-shell.ts";

export type PrsloyState = {
  baseUrl: string;
  migrations?: string[];
  /** Chat + image model ids the gateway's `/v1/models` listed, and when. */
  models?: { ids: string[]; checkedAt: string };
};

/** The slice of RuntimeBoot the context needs (absent outside the Electron app). */
export type RuntimesLike = {
  state(): { status: "absent" | "installing" | "ready" | "failed"; done?: number; total?: number };
  whenReady(timeoutMs: number): Promise<boolean>;
};

const NO_RUNTIMES: RuntimesLike = {
  state: () => ({ status: "absent" }),
  whenReady: async () => true,
};

/**
 * Combine Node/Python unpack (files) and Git unpack (percent) into one number, weighted by
 * their file counts. Ready parts count as done; absent parts are left out.
 */
export function combineSetupProgress(
  runtimes: { status: string; done?: number; total?: number },
  git: { status: string; percent?: number },
  gitFiles: number | undefined,
): { status: "absent" | "installing" | "ready" | "failed"; percent?: number } {
  const parts: { weight: number; percent: number }[] = [];
  const statuses = [runtimes.status, git.status];
  if (statuses.includes("failed")) return { status: "failed" };
  if (!statuses.includes("installing")) {
    return statuses.includes("ready") ? { status: "ready" } : { status: "absent" };
  }
  if (runtimes.status === "installing" || runtimes.status === "ready") {
    const weight = runtimes.total ?? 10_000;
    const pct =
      runtimes.status === "ready"
        ? 100
        : runtimes.total
          ? Math.min(99, ((runtimes.done ?? 0) / runtimes.total) * 100)
          : 0;
    parts.push({ weight, percent: pct });
  }
  if (git.status === "installing" || git.status === "ready") {
    parts.push({
      weight: gitFiles ?? 9_000,
      percent: git.status === "ready" ? 100 : (git.percent ?? 0),
    });
  }
  const totalWeight = parts.reduce((sum, p) => sum + p.weight, 0);
  const percent = parts.reduce((sum, p) => sum + p.percent * p.weight, 0) / totalWeight;
  return { status: "installing", percent: Math.min(99, Math.floor(percent)) };
}

export type PrsloyContext = {
  paths: PrsloyHomePaths;
  agentDir: string;
  sessionDir: string;
  /** prsloy-harness extensions run in every session (bundled into the host). */
  harnessEnabled: boolean;
  /** Windows only: what pi's bash tool runs. */
  readonly shellPath: string | undefined;
  readonly shellSource: "bundled" | "system" | "missing" | undefined;
  /** git for turn snapshots, re-resolved per call (PortableGit may still be unpacking). */
  gitBinary(): string;
  /** PortableGit unpacked in the background on first launch (Windows). */
  git: GitRuntime;
  /** Node/Python unpacked in the background on first launch (window first). */
  runtimes: RuntimesLike;
  /** Re-point python shims / rg+fd once the runtimes are unpacked. */
  refreshRuntimes(pythonExecutable: string | undefined): void;
  /** One first-launch progress value for «Готовлю приложение… N%». */
  setupProgress(): { status: "absent" | "installing" | "ready" | "failed"; percent?: number };
  keyStore: PrsloyKeyStore;
  snapshots: TurnSnapshots;
  getState(): PrsloyState;
  /** Persist + rewrite models.json. Returns the normalized URL. */
  setBaseUrl(raw: string): string;
  /**
   * What the gateway's `/v1/models` serves now: kept in state.json, models.json narrowed to
   * it, a default model it no longer serves replaced. True when models.json changed.
   */
  setAvailableModels(ids: readonly string[], now?: Date): boolean;
  /** Last known list (undefined: never checked, or a gateway without `/models`). */
  availableModels(): string[] | undefined;
  /** Agent Host env: scrubbed, shims first, pinned home, key handoff. */
  hostEnv(base: Record<string, string | undefined>): Record<string, string>;
};

function readState(path: string): PrsloyState {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PrsloyState>;
    const baseUrl = normalizePrsloyBaseUrl(parsed.baseUrl) ?? PRSLOY_DEFAULT_BASE_URL;
    const models = parsed.models;
    const ids = Array.isArray(models?.ids) ? models.ids.filter((m) => typeof m === "string") : [];
    return {
      baseUrl,
      ...(Array.isArray(parsed.migrations)
        ? { migrations: parsed.migrations.filter((m) => typeof m === "string") }
        : {}),
      ...(ids.length && typeof models?.checkedAt === "string"
        ? { models: { ids, checkedAt: models.checkedAt } }
        : {}),
    };
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
  /** Shipped PortableGit self-extractor (Windows packaged builds). */
  gitArchive?: { path: string; version?: string | undefined; files?: number | undefined };
  /** `<resources>/runtimes/git`, unpacked by the NSIS installer (used when complete). */
  installerGitDir?: string | undefined;
  onGitSetup?: (state: GitSetupState) => void;
  runtimes?: RuntimesLike;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): PrsloyContext {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const paths = prsloyHomePaths(options.userDataPath);
  const agentDir = resolvePrsloyAgentDir(options.userDataPath, env);
  const sessionDir = join(agentDir, "sessions");
  ensurePrsloyHomeDirs(paths, agentDir);
  // The encrypted gateway key lives here: user-only ACL before anything is written.
  const acl = restrictToCurrentUser(paths.stateDir, { isDir: true, platform, env });
  if (!acl.ok) console.warn("[prsloy] could not restrict state dir:", acl.detail);
  mkdirSync(sessionDir, { recursive: true });

  // Everything in this process that asks pi for its home (TUI, package manager,
  // defaultAgentDir()) now resolves to the isolated dir.
  env.PI_CODING_AGENT_DIR = agentDir;
  env.PI_CODING_AGENT_SESSION_DIR = sessionDir;

  const statePath = join(paths.stateDir, "state.json");
  let state = readState(statePath);

  const runtimesRoot = options.runtimesRoot ?? join(options.userDataPath, "runtimes");
  const installerGit = isInstallerGit(options.installerGitDir)
    ? options.installerGitDir
    : undefined;
  const bundledGitRoot = installerGit ?? join(runtimesRoot, "git");
  let shellPath: string | undefined;
  let shellSource: PrsloyContext["shellSource"];
  // Re-run when PortableGit finishes unpacking: bundled bash wins over a system Git.
  const refreshShell = () => {
    if (platform !== "win32") return;
    const chosen = chooseWindowsShellPath({ bundledGitRoot, env });
    shellPath = chosen.shellPath;
    shellSource = chosen.source;
    ensurePrsloySettings(agentDir, { shellPath, available: state.models?.ids });
  };
  const gitBinary = () => chooseGitBinary({ platform, bundledGitRoot, env });

  ensurePrsloyModelsJson(agentDir, state.baseUrl, state.models?.ids);
  const MCP_MIGRATION = "no-auto-mcp-adapter";
  const dropAutoMcpAdapter = !state.migrations?.includes(MCP_MIGRATION);
  ensurePrsloySettings(agentDir, { shellPath, dropAutoMcpAdapter, available: state.models?.ids });
  if (dropAutoMcpAdapter) {
    state = { ...state, migrations: [...(state.migrations ?? []), MCP_MIGRATION] };
    writeState(statePath, state);
  }
  refreshShell();
  const refreshRuntimes = (pythonExecutable: string | undefined) => {
    installSearchTools(join(runtimesRoot, "tools"), agentDir);
    try {
      writeAgentShims({ shimsDir: paths.shimsDir, pythonExecutable, platform });
    } catch (error) {
      console.warn("[prsloy] writing agent shims failed:", error);
    }
  };
  refreshRuntimes(options.pythonExecutable);

  const harnessEnabled = env.PRSLOY_HARNESS !== "0";
  const keyStore = new PrsloyKeyStore(join(paths.stateDir, "gateway-key.bin"), options.cipher);
  const snapshots = new TurnSnapshots({ root: paths.snapshotsDir, gitBinary, platform });
  const git = new GitRuntime({
    runtimesRoot,
    archive: options.gitArchive?.path,
    version: options.gitArchive?.version,
    expectedFiles: options.gitArchive?.files,
    readyDir: installerGit,
    onChange: (gitState) => {
      if (gitState.status === "ready") refreshShell();
      options.onGitSetup?.(gitState);
    },
  });

  return {
    paths,
    agentDir,
    sessionDir,
    harnessEnabled,
    get shellPath() {
      return shellPath;
    },
    get shellSource() {
      return shellSource;
    },
    gitBinary,
    git,
    runtimes: options.runtimes ?? NO_RUNTIMES,
    refreshRuntimes,
    setupProgress: () =>
      combineSetupProgress(
        (options.runtimes ?? NO_RUNTIMES).state(),
        git.state(),
        options.gitArchive?.files,
      ),
    keyStore,
    snapshots,
    getState: () => ({ ...state }),
    setBaseUrl(raw) {
      const baseUrl = normalizePrsloyBaseUrl(raw);
      if (!baseUrl) throw new Error("Invalid gateway URL");
      // Another gateway serves other models: forget the old list until it is checked.
      const { models: _old, ...rest } = state;
      state = baseUrl === state.baseUrl ? state : { ...rest, baseUrl };
      writeState(statePath, state);
      ensurePrsloyModelsJson(agentDir, baseUrl, state.models?.ids);
      return baseUrl;
    },
    setAvailableModels(rawIds, now = new Date()) {
      const ids = [...new Set(rawIds.filter((id) => typeof id === "string" && id))];
      if (ids.length === 0) return false;
      state = { ...state, models: { ids, checkedAt: now.toISOString() } };
      writeState(statePath, state);
      const changed = ensurePrsloyModelsJson(agentDir, state.baseUrl, ids);
      ensurePrsloySettings(agentDir, { shellPath, available: ids });
      return changed;
    },
    availableModels: () => (state.models ? [...state.models.ids] : undefined),
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
