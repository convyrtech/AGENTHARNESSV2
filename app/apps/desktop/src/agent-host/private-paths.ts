/**
 * Places the agent must not read at all, without asking (casual safety, prompt injection):
 * the app's own folder (other chats, settings, memory), credentials of other tools
 * (`~/.ssh`, `~/.aws`, …), browser profiles and Telegram's session. Everything else outside
 * the project stays readable: «возьми файл из Загрузок» must keep working.
 *
 * Checked for pi's read / grep / find / ls tools and for every word of a bash command that
 * resolves to such a place (cat, ls, grep, cp, tar — the command does not matter). A
 * recursive command or a glob over a folder that contains one (`grep -r x ~`, `ls ~/.s*`)
 * counts too. A command we can't follow (`$(…)`, unknown variables) is judged by the names
 * in it.
 */
import { basename, dirname, join, relative, win32 } from "node:path";
import { resolveToolPath } from "@prsloy/harness";
import {
  commandName,
  expandHome,
  platformOf,
  realish,
  splitCommand,
  type BoundaryEnv,
} from "./write-boundary-rules.ts";

export const PRIVATE_READ_NOTE = "Это личные данные пользователя, их читать нельзя.";

export type PrivateEnv = BoundaryEnv & {
  /** Folders nobody but the app reads. */
  privateRoots: string[];
  /** Exceptions inside them the agent legitimately uses (bundled runtimes, skills). */
  publicRoots: string[];
  appData?: string;
  localAppData?: string;
};

/** The agent's private places for this machine (Windows, macOS and Linux spellings). */
export function privateRootsFor(options: {
  platform: NodeJS.Platform;
  home: string;
  agentDir?: string;
  appData?: string;
  localAppData?: string;
}): { privateRoots: string[]; publicRoots: string[] } {
  const win = options.platform === "win32";
  const at = (...parts: string[]) => (win ? win32.join(...parts) : join(...parts));
  const home = options.home;
  const appData = options.appData ?? at(home, "AppData", "Roaming");
  const localAppData = options.localAppData ?? at(home, "AppData", "Local");
  const privateRoots = [
    ...[".ssh", ".aws", ".config/gcloud", ".docker/config.json", ".npmrc", ".git-credentials"].map(
      (rel) => at(home, ...rel.split("/")),
    ),
    at(home, ".netrc"),
    at(home, "_netrc"),
  ];
  if (win) {
    privateRoots.push(
      at(localAppData, "Google", "Chrome", "User Data"),
      at(localAppData, "Microsoft", "Edge", "User Data"),
      at(localAppData, "Yandex", "YandexBrowser", "User Data"),
      at(localAppData, "Mozilla", "Firefox", "Profiles"),
      at(appData, "Mozilla", "Firefox", "Profiles"),
      at(appData, "Telegram Desktop", "tdata"),
    );
  } else {
    const support = at(home, "Library", "Application Support");
    privateRoots.push(
      at(home, ".config", "google-chrome"),
      at(home, ".config", "chromium"),
      at(home, ".config", "microsoft-edge"),
      at(home, ".config", "yandex-browser"),
      at(home, ".mozilla", "firefox"),
      at(home, ".local", "share", "TelegramDesktop"),
      at(support, "Google", "Chrome"),
      at(support, "Microsoft Edge"),
      at(support, "Yandex", "YandexBrowser"),
      at(support, "Firefox", "Profiles"),
      at(support, "Telegram Desktop"),
    );
  }
  const publicRoots: string[] = [];
  if (options.agentDir) {
    const agentDir = options.agentDir;
    // The app keeps the agent home at userData/agent: the whole userData is the app's.
    const path = win ? win32 : { basename, dirname };
    const userData = path.basename(agentDir) === "agent" ? path.dirname(agentDir) : undefined;
    privateRoots.push(userData ?? agentDir);
    publicRoots.push(at(agentDir, "bin"), at(agentDir, "skills"), at(agentDir, "prompts"));
    if (userData) {
      publicRoots.push(
        at(userData, "runtimes"),
        at(userData, "agent-shims"),
        at(userData, "design"),
      );
    }
  }
  return { privateRoots, publicRoots };
}

/** Names that give a private place away when we can't resolve the path itself. */
const PRIVATE_NAMES =
  /\.ssh|\.aws|gcloud|\.docker|\.npmrc|git-credentials|[._]netrc|user data|firefox|\.mozilla|tdata|telegram|google-chrome|yandex|auth\.json|prsloy/iu;

function norm(path: string, env: PrivateEnv): string {
  const win = platformOf(env) === "win32";
  // realpath only means something for paths of the platform we run on.
  const real = win === (process.platform === "win32") ? realish(path) : path;
  return win ? real.toLowerCase() : real;
}

function within(path: string, root: string, env: PrivateEnv): boolean {
  const win = platformOf(env) === "win32";
  const rel = win ? win32.relative(root, path) : relative(root, path);
  return (
    rel === "" || (!rel.startsWith("..") && !(win ? win32.isAbsolute(rel) : rel.startsWith("/")))
  );
}

/** True when `path` is private; with `orAncestor`, also when it contains a private place. */
export function isPrivatePath(path: string, env: PrivateEnv, orAncestor = false): boolean {
  const target = norm(path, env);
  const cwd = norm(env.cwd, env);
  return env.privateRoots.some((rawRoot) => {
    const root = norm(rawRoot, env);
    if (within(target, root, env)) {
      if (env.publicRoots.some((p) => within(target, norm(p, env), env))) return false;
      // A project the app itself keeps there (a «Дизайн» workspace) is the agent's own.
      return !(within(cwd, root, env) && within(target, cwd, env));
    }
    return orAncestor && within(root, target, env);
  });
}

function expandAppVars(arg: string, env: PrivateEnv): string {
  const win = platformOf(env) === "win32";
  const home = env.home ?? "";
  const appData = env.appData ?? (win ? win32.join(home, "AppData", "Roaming") : "");
  const local = env.localAppData ?? (win ? win32.join(home, "AppData", "Local") : "");
  if (!win) return arg;
  return arg
    .replace(/^(?:%APPDATA%|\$\{?APPDATA\}?|\$env:APPDATA)(?=$|[\\/])/iu, appData)
    .replace(/^(?:%LOCALAPPDATA%|\$\{?LOCALAPPDATA\}?|\$env:LOCALAPPDATA)(?=$|[\\/])/iu, local);
}

type Candidate = { path: string; globbed: boolean } | "unknown" | undefined;

function candidatePath(word: string, cwd: string, env: PrivateEnv): Candidate {
  if (!word || word.includes("://")) return undefined;
  const expanded = expandHome(expandAppVars(word, env), env);
  if (expanded === undefined) return "unknown";
  const globbed = /[*?[]/u.test(expandAppVars(word, env));
  return { path: resolveToolPath(expanded, cwd, platformOf(env), env.home), globbed };
}

const RECURSIVE_COMMANDS = new Set([
  "find", "rg", "ag", "tar", "zip", "7z", "rsync", "robocopy", "xcopy", "tree", "du",
  "get-childitem", "gci", "compress-archive",
]); // prettier-ignore

function recursive(name: string, args: string[]): boolean {
  if (RECURSIVE_COMMANDS.has(name)) return true;
  return args.some(
    (a) =>
      a === "--recursive" ||
      /^-recurse$/iu.test(a) ||
      /^\/s$/iu.test(a) ||
      (/^-[A-Za-z]+$/u.test(a) && shortRecursive(name).test(a)),
  );
}

/** Which short flag means "the whole tree" for this command. */
function shortRecursive(name: string): RegExp {
  if (name === "ls") return /R/u;
  if (name === "cp" || name === "scp") return /[rRa]/u;
  if (name === "rm" || name === "mv") return /$^/u;
  return /[rR]/u;
}

/** pi's read / grep / find / ls tools. */
export function readsPrivateFile(
  toolName: string,
  input: Record<string, unknown>,
  env: PrivateEnv,
): boolean {
  if (!["read", "grep", "find", "ls"].includes(toolName)) return false;
  const raw = typeof input.path === "string" && input.path ? input.path : ".";
  const found = candidatePath(raw, env.cwd, env);
  if (found === "unknown") return PRIVATE_NAMES.test(raw);
  if (!found) return false;
  const deep = toolName === "grep" || toolName === "find";
  return isPrivatePath(found.path, env, deep || found.globbed);
}

/** bash: any word of the command that lands in a private place. */
export function bashReadsPrivate(command: string, env: PrivateEnv): boolean {
  const segments = /\$\(|`|<\(|\beval\b/u.test(command) ? undefined : splitCommand(command);
  if (!segments) return PRIVATE_NAMES.test(command);
  let cwd = env.cwd;
  for (const { tokens, redirects } of segments) {
    let i = 0;
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[i]!)) i++;
    const name = i < tokens.length ? commandName(tokens[i]!) : "";
    const args = tokens.slice(i + 1);
    const deep = recursive(name, args);
    const words = [...tokens, ...redirects].flatMap((token) => {
      const parts = token.split("<");
      const value = /^-[^=]*=/u.exec(token) ? token.slice(token.indexOf("=") + 1) : undefined;
      return value === undefined ? parts : [...parts, value];
    });
    for (const word of words) {
      const found = candidatePath(word, cwd, env);
      if (found === "unknown") {
        if (PRIVATE_NAMES.test(word)) return true;
        continue;
      }
      if (found && isPrivatePath(found.path, env, deep || found.globbed)) return true;
    }
    if (name === "cd" || name === "pushd" || name === "set-location") {
      const dest = args.find((a) => !a.startsWith("-"));
      const next = dest === undefined ? undefined : candidatePath(dest, cwd, env);
      // `cd` alone goes home; into somewhere we can't follow, judge later words by name.
      if (dest === undefined) cwd = env.home ?? cwd;
      else if (next === "unknown") return PRIVATE_NAMES.test(command);
      else if (next) cwd = next.path;
    }
  }
  return false;
}
