/**
 * PRSLOY isolated pi home under Electron userData.
 *
 * The desktop agent never reads or writes the CLI's `~/.pi/agent`: models, settings,
 * trust decisions, extensions' bin dir (fd/rg) and sessions all live under
 * `userData/agent`. Main exports `PI_CODING_AGENT_DIR` early so every code path that
 * calls pi `getAgentDir()` (host, pi TUI, package manager) lands here.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  buildPrsloyModelsJsonProvider,
  PRSLOY_DEFAULT_SPEED_MODE,
  PRSLOY_PROVIDER_ID,
  PRSLOY_SPEED_MODES,
} from "../../shared/prsloy-config.ts";

export type PrsloyHomePaths = {
  /** pi agent dir (models.json, settings.json, trust, bin/). */
  agentDir: string;
  /** Session JSONL root (`PI_CODING_AGENT_SESSION_DIR`). */
  sessionDir: string;
  /** Shims prepended to the agent PATH (blocked AI CLIs, python3). */
  shimsDir: string;
  /** Shadow git repos for per-turn undo. */
  snapshotsDir: string;
  /** Desktop-side PRSLOY state (base URL, encrypted key). */
  stateDir: string;
};

export function prsloyHomePaths(userDataPath: string): PrsloyHomePaths {
  const agentDir = join(userDataPath, "agent");
  return {
    agentDir,
    sessionDir: join(agentDir, "sessions"),
    shimsDir: join(userDataPath, "agent-shims"),
    snapshotsDir: join(userDataPath, "snapshots"),
    stateDir: join(userDataPath, "prsloy"),
  };
}

/**
 * Agent dir to use. Test harnesses (`ZENO_ENABLE_TEST_COMMANDS=1`) may pin their own
 * isolated dir via `PI_CODING_AGENT_DIR`; a user's global `PI_CODING_AGENT_DIR` (CLI pi)
 * is ignored so the app never shares state with a CLI install.
 */
export function resolvePrsloyAgentDir(userDataPath: string, env: NodeJS.ProcessEnv): string {
  const pinned = env.PI_CODING_AGENT_DIR?.trim();
  if (pinned && env.ZENO_ENABLE_TEST_COMMANDS === "1") return pinned;
  return prsloyHomePaths(userDataPath).agentDir;
}

function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // A corrupt file must not brick startup; keep a copy for diagnosis and start clean.
    try {
      renameSync(path, `${path}.corrupt-${Date.now()}`);
    } catch {
      // ignore
    }
    return {};
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

/**
 * Write/refresh `providers.prsloy` in models.json, keeping any other providers the
 * developer added under «Для разработчиков». Returns true when the file changed.
 */
export function ensurePrsloyModelsJson(agentDir: string, baseUrl: string): boolean {
  const path = join(agentDir, "models.json");
  const root = readJsonObject(path);
  const providers =
    root.providers && typeof root.providers === "object" && !Array.isArray(root.providers)
      ? { ...(root.providers as Record<string, unknown>) }
      : {};
  const next = buildPrsloyModelsJsonProvider(baseUrl);
  if (JSON.stringify(providers[PRSLOY_PROVIDER_ID]) === JSON.stringify(next) && existsSync(path)) {
    return false;
  }
  providers[PRSLOY_PROVIDER_ID] = next;
  writeJsonAtomic(path, { ...root, providers });
  return true;
}

export type PrsloySettingsSeed = {
  /** Windows: bundled Git Bash. Undefined elsewhere (pi uses /bin/bash). */
  shellPath?: string | undefined;
};

/**
 * Seed pi settings.json: PRSLOY default model, our shell, no powershell tool.
 * Only fills defaults the user has not chosen; `shellPath` is always enforced so a
 * stale value can never fall through to WSL bash.
 */
export function ensurePrsloySettings(agentDir: string, seed: PrsloySettingsSeed): boolean {
  const path = join(agentDir, "settings.json");
  const before = readJsonObject(path);
  const next: Record<string, unknown> = { ...before };
  if (typeof next.defaultProvider !== "string" || typeof next.defaultModel !== "string") {
    next.defaultProvider = PRSLOY_PROVIDER_ID;
    next.defaultModel = PRSLOY_SPEED_MODES[PRSLOY_DEFAULT_SPEED_MODE].modelId;
  }
  if (seed.shellPath) next.shellPath = seed.shellPath;
  else delete next.shellPath;
  // Keep the optional powershell tool off: drop it from an explicit tool list.
  if (Array.isArray(next.defaultTools)) {
    next.defaultTools = next.defaultTools.filter((tool) => tool !== "powershell");
  }
  if (JSON.stringify(before) === JSON.stringify(next) && existsSync(path)) return false;
  writeJsonAtomic(path, next);
  return true;
}

export function ensurePrsloyHomeDirs(paths: PrsloyHomePaths, agentDir = paths.agentDir): void {
  for (const dir of [
    agentDir,
    paths.sessionDir,
    paths.shimsDir,
    paths.snapshotsDir,
    paths.stateDir,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Copy bundled rg/fd into `<agentDir>/bin`: pi's tools-manager checks there first, so
 * grep/find never try to download them from GitHub. Returns the installed names.
 */
export function installSearchTools(toolsDir: string, agentDir: string): string[] {
  if (!existsSync(toolsDir)) return [];
  const binDir = join(agentDir, "bin");
  const installed: string[] = [];
  for (const name of readdirSync(toolsDir)) {
    if (!/^(rg|fd)(\.exe)?$/u.test(name)) continue;
    const from = join(toolsDir, name);
    const to = join(binDir, name);
    try {
      if (existsSync(to) && statSync(to).size === statSync(from).size) {
        installed.push(name);
        continue;
      }
      mkdirSync(binDir, { recursive: true });
      copyFileSync(from, to);
      installed.push(name);
    } catch (error) {
      console.warn(`[prsloy] installing ${name} failed:`, error);
    }
  }
  return installed;
}
