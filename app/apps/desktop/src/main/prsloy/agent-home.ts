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
  PRSLOY_SPEED_PREFERENCE,
  prsloyFallbackModelId,
  prsloySpeedModelId,
  type PrsloySpeedMode,
} from "../../shared/prsloy-config.ts";
import type { RubPricePerM } from "../../shared/prsloy-prices.ts";

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
export function ensurePrsloyModelsJson(
  agentDir: string,
  baseUrl: string,
  /** What the gateway serves (`/v1/models`); undefined = not known, whole catalog. */
  available?: readonly string[],
  /** Retail prices in ₽ per 1M (#52); undefined = the bundled snapshot. */
  prices?: Readonly<Record<string, RubPricePerM>>,
): boolean {
  const path = join(agentDir, "models.json");
  const root = readJsonObject(path);
  const providers =
    root.providers && typeof root.providers === "object" && !Array.isArray(root.providers)
      ? { ...(root.providers as Record<string, unknown>) }
      : {};
  const next = buildPrsloyModelsJsonProvider(baseUrl, available, prices);
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
  /** One-time migration: drop the npm:pi-mcp-adapter that early alphas auto-installed. */
  dropAutoMcpAdapter?: boolean;
  /** Models the gateway serves: a PRSLOY default it no longer serves moves to its preset's next. */
  available?: readonly string[] | undefined;
};

/** Package source early alphas installed from npm on first launch. */
export const AUTO_MCP_ADAPTER_SOURCE = "npm:pi-mcp-adapter";

function packageSource(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object" && "source" in entry) {
    const source = (entry as { source?: unknown }).source;
    return typeof source === "string" ? source : undefined;
  }
  return undefined;
}

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
    next.defaultModel = prsloySpeedModelId(PRSLOY_DEFAULT_SPEED_MODE, seed.available);
  } else if (
    next.defaultProvider === PRSLOY_PROVIDER_ID &&
    seed.available &&
    !seed.available.includes(next.defaultModel)
  ) {
    // A model the gateway stopped serving: the same preset's next model, else «Быстрее».
    const mode = (Object.keys(PRSLOY_SPEED_PREFERENCE) as PrsloySpeedMode[]).find((m) =>
      PRSLOY_SPEED_PREFERENCE[m].includes(next.defaultModel as string),
    );
    next.defaultModel =
      prsloyFallbackModelId(next.defaultModel, seed.available) ??
      prsloySpeedModelId(mode ?? PRSLOY_DEFAULT_SPEED_MODE, seed.available);
  }
  if (seed.shellPath) next.shellPath = seed.shellPath;
  else delete next.shellPath;
  // MCP off by default (casual alpha): pi's built-in MCP stays unloaded until a developer
  // removes this entry. Only seeded when the user has no `extensions` list of their own.
  if (!Array.isArray(next.extensions)) next.extensions = ["-builtin:mcp"];
  if (seed.dropAutoMcpAdapter && Array.isArray(next.packages)) {
    next.packages = next.packages.filter(
      (entry) => packageSource(entry) !== AUTO_MCP_ADAPTER_SOURCE,
    );
  }
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
