/**
 * Clean environment for the Agent Host (and therefore every tool process it spawns:
 * pi's bash tool inherits the host's `process.env`).
 *
 * - machine secrets are dropped (`*_TOKEN`, `*_KEY`, `AWS_*`, …)
 * - a shims dir goes first on PATH: other AI CLIs answer «запрещено харнессом»,
 *   `python3` / `python` point at the bundled interpreter
 * - pi is pinned to the isolated agent home, offline for its own downloads
 */
import {
  HOST_HANDOFF_TYPE,
  type HostHandoffMessage,
  parseSearchHandoff,
} from "../../shared/host-handoff.ts";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Exact message the blocked CLIs print (owner-facing wording). */
export const BLOCKED_CLI_MESSAGE = "запрещено харнессом";

/** AI coding CLIs the agent must not delegate to (they would bypass the harness). */
export const BLOCKED_AI_CLIS = [
  "claude",
  "codex",
  "gemini",
  "aider",
  "cursor-agent",
  "opencode",
  "qwen",
  "kimi",
] as const;

const SECRET_SUFFIXES = ["_TOKEN", "_KEY", "_SECRET", "_PASSWORD"];
const SECRET_PREFIXES = ["AWS_", "GH_", "GITHUB_", "AZURE_", "GOOGLE_", "OPENAI_", "ANTHROPIC_"];

/** Env var names that carry machine credentials (case-insensitive: Windows env is). */
export function isSecretEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  if (SECRET_SUFFIXES.some((suffix) => upper.endsWith(suffix))) return true;
  return SECRET_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

export function scrubSecretEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || isSecretEnvName(key)) continue;
    out[key] = value;
  }
  return out;
}

/** The PATH key actually present (Windows env is usually `Path`). */
export function pathKeyOf(env: Record<string, string | undefined>, platform = process.platform) {
  if (platform !== "win32") return "PATH";
  return Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "Path";
}

export function prependPath(
  env: Record<string, string>,
  dirs: string[],
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const delimiter = platform === "win32" ? ";" : ":";
  const key = pathKeyOf(env, platform);
  const current = (env[key] ?? "").split(delimiter).filter(Boolean);
  const norm = (dir: string) => (platform === "win32" ? dir.toLowerCase() : dir);
  const front = dirs.filter(Boolean);
  const frontKeys = new Set(front.map(norm));
  const rest = current.filter((dir) => !frontKeys.has(norm(dir)));
  const next = { ...env };
  // Collapse duplicate PATH spellings on Windows so the child sees exactly one.
  if (platform === "win32") {
    for (const k of Object.keys(next)) if (k.toUpperCase() === "PATH" && k !== key) delete next[k];
  }
  next[key] = [...front, ...rest].join(delimiter);
  return next;
}

function toPosixPathForMsys(path: string): string {
  // Git Bash accepts `C:/x/y`; keep the drive letter form, only flip separators.
  return path.replace(/\\/g, "/");
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export type ShimOptions = {
  shimsDir: string;
  /** Interpreter that `python` / `python3` should run (venv or bundled). */
  pythonExecutable?: string | undefined;
  platform?: NodeJS.Platform;
};

/**
 * (Re)write the shims dir. For every name we write an extensionless `#!/bin/sh` script
 * (bash, incl. Git Bash, runs it via the shebang) and on Windows also a `.cmd` twin for
 * cmd / PowerShell callers.
 */
export function writeAgentShims(options: ShimOptions): string[] {
  const platform = options.platform ?? process.platform;
  const dir = options.shimsDir;
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  const write = (name: string, content: string, executable: boolean) => {
    const path = join(dir, name);
    writeFileSync(path, content, "utf8");
    if (executable && platform !== "win32") chmodSync(path, 0o755);
    written.push(path);
  };

  for (const cli of BLOCKED_AI_CLIS) {
    write(cli, `#!/bin/sh\necho ${shQuote(BLOCKED_CLI_MESSAGE)} >&2\nexit 126\n`, true);
    if (platform === "win32") {
      write(
        `${cli}.cmd`,
        `@echo off\r\nchcp 65001 >nul\r\necho ${BLOCKED_CLI_MESSAGE} 1>&2\r\nexit /b 126\r\n`,
        false,
      );
    }
  }

  const python = options.pythonExecutable;
  if (python) {
    const target = platform === "win32" ? toPosixPathForMsys(python) : python;
    for (const name of ["python3", "python"]) {
      write(name, `#!/bin/sh\nexec ${shQuote(target)} "$@"\n`, true);
      if (platform === "win32") write(`${name}.cmd`, `@"${python}" %*\r\n`, false);
    }
  }
  return written;
}

export type PrsloyHostEnvOptions = {
  agentDir: string;
  sessionDir: string;
  shimsDir: string;
  /** Gateway key handed to the host; the host removes it from its env at boot. */
  gatewayKey?: string | undefined;
  platform?: NodeJS.Platform;
};

/** Env var the host reads (and deletes) at boot. Added after the scrub on purpose. */
export const GATEWAY_KEY_HANDOFF_ENV = "PRSLOY_GATEWAY_KEY";
/**
 * The old env name for the web search config (issue #23). Search keys now go in `host.start` over the message
 * channel (review #23, item 5); a stale value in the user's own env is still removed.
 */
export const SEARCH_HANDOFF_ENV = "PRSLOY_SEARCH_HANDOFF";

/**
 * Before the fork: take the gateway key and the search config out of the host's env and into the
 * handoff message main posts over parentPort (shared/host-handoff.ts). The spawn env of the host
 * never carries them, so no tool process can read them from /proc/<ppid>/environ.
 */
export function splitHostHandoff(env: Record<string, string>): {
  env: Record<string, string>;
  handoff: HostHandoffMessage;
} {
  const { [GATEWAY_KEY_HANDOFF_ENV]: key, [SEARCH_HANDOFF_ENV]: search, ...rest } = env;
  const parsed = parseSearchHandoff(search);
  return {
    env: rest,
    handoff: {
      type: HOST_HANDOFF_TYPE,
      ...(key?.trim() ? { gatewayKey: key.trim() } : {}),
      ...(parsed ? { search: parsed } : {}),
    },
  };
}

export function buildPrsloyHostEnv(
  base: Record<string, string | undefined>,
  options: PrsloyHostEnvOptions,
): Record<string, string> {
  const platform = options.platform ?? process.platform;
  let env = scrubSecretEnv(base);
  env = prependPath(env, [options.shimsDir], platform);
  env.PI_CODING_AGENT_DIR = options.agentDir;
  env.PI_CODING_AGENT_SESSION_DIR = options.sessionDir;
  // No fd/rg/package downloads from GitHub at tool time (often unreachable from RU).
  env.PI_OFFLINE = "1";
  // Git inside agent commands must never pop a credential/editor window.
  env.GIT_TERMINAL_PROMPT = "0";
  env.GCM_INTERACTIVE = "never";
  // No editor / pager can block a tool call (`git commit` without -m, `git log`).
  env.GIT_EDITOR = "true";
  env.EDITOR = "true";
  env.VISUAL = "true";
  env.GIT_PAGER = "cat";
  env.PAGER = "cat";
  // Python writes UTF-8 to pipes (Windows defaults to the ANSI code page: «привет» → cp1252
  // UnicodeEncodeError, or mojibake under cp1251); the «Дизайн» env does the same.
  env.PYTHONUTF8 = "1";
  env.PYTHONIOENCODING = "utf-8";
  // prsloy-harness profile for the «Код» tab.
  env.PRSLOY_PROFILE = "code";
  if (options.gatewayKey) env[GATEWAY_KEY_HANDOFF_ENV] = options.gatewayKey;
  // Search keys never go through env (a child or /proc/<pid>/environ would see them): host.start carries them.
  delete env[SEARCH_HANDOFF_ENV];
  return env;
}
