/**
 * Where the agent may change files without asking (stage 6, casual safety).
 *
 * Inside the project folder (and the system temp dir) everything goes. Outside it:
 * - write / edit of a file → ask the user;
 * - bash that deletes or moves files there, writes there through a redirect, force-pushes
 *   in git, or runs a system-level destructive command (format, reg add/delete, …) → ask.
 *
 * The bash check is a deliberately conservative tokenizer, not a shell: anything it cannot
 * follow (variables, command substitution, unbalanced quotes, `eval`, `xargs rm`, …) next to
 * a destructive word counts as "outside" and is asked about.
 */
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, win32 } from "node:path";
import { resolveToolPath } from "@prsloy/harness";

export type BoundaryEnv = {
  cwd: string;
  /** Folders where changes never need asking (the project, the system temp dir). */
  allowedRoots: string[];
  platform?: NodeJS.Platform;
  home?: string;
  /** The system temp dir: what `$TMP`, `$TEMP`, `$TMPDIR` and Git Bash's `/tmp` mean. */
  tmp?: string;
};

export type BoundaryVerdict = { ask: false } | { ask: true; question: string; key: string };

const QUESTION_TAIL = "Разрешить?";

export function platformOf(env: BoundaryEnv): NodeJS.Platform {
  return env.platform ?? process.platform;
}

/** Follow symlinks of the deepest existing ancestor, so a link can't smuggle a path out. */
export function realish(path: string): string {
  let current = path;
  const rest: string[] = [];
  for (let i = 0; i < 64; i++) {
    try {
      return join(realpathSync(current), ...rest.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      rest.push(current.slice(parent.length).replace(/^[\\/]+/, ""));
      current = parent;
    }
  }
  return path;
}

export function isInsideRoots(path: string, env: BoundaryEnv): boolean {
  const win = platformOf(env) === "win32";
  const norm = (p: string) => (win ? p.toLowerCase() : p);
  const target = norm(realish(path));
  return env.allowedRoots.some((root) => {
    const base = norm(realish(root));
    const rel = win ? win32.relative(base, target) : relative(base, target);
    return (
      rel === "" || (!rel.startsWith("..") && !(win ? win32.isAbsolute(rel) : isAbsolute(rel)))
    );
  });
}

/** write / edit: the target file. */
export function classifyFileWrite(rawPath: string, env: BoundaryEnv): BoundaryVerdict {
  const path = resolveToolPath(rawPath, env.cwd, platformOf(env), env.home);
  if (isInsideRoots(path, env)) return { ask: false };
  return {
    ask: true,
    question: `Агент хочет изменить файл вне проекта: ${path}. ${QUESTION_TAIL}`,
    key: `file:${path}`,
  };
}

// ── bash ────────────────────────────────────────────────────────────────────────────

export type Segment = { tokens: string[]; redirects: string[] };

/** Split on unquoted ; && || | & and newlines; undefined when quotes don't balance. */
export function splitCommand(command: string): Segment[] | undefined {
  const segments: Segment[] = [];
  let tokens: string[] = [];
  let redirects: string[] = [];
  let current = "";
  let has = false;
  let quote: '"' | "'" | undefined;
  let pendingRedirect = false;
  const pushToken = () => {
    if (!has) return;
    if (pendingRedirect) redirects.push(current);
    else tokens.push(current);
    pendingRedirect = false;
    current = "";
    has = false;
  };
  const pushSegment = () => {
    pushToken();
    if (tokens.length || redirects.length) segments.push({ tokens, redirects });
    tokens = [];
    redirects = [];
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) quote = undefined;
      // In "…" a backslash escapes only $ ` " \ and newline, as in bash: "C:\Users\x" stays.
      else if (ch === "\\" && quote === '"' && /[$`"\\\n]/u.test(command[i + 1] ?? "")) {
        current += command[++i];
      } else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    // Escapes only before shell-special characters: `C:\Users\me` stays a Windows path.
    if (ch === "\\" && /[\s"'\\;&|<>$`*?()]/u.test(command[i + 1] ?? "a")) {
      current += command[++i];
      has = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      pushToken();
      continue;
    }
    if (ch === "\n" || ch === ";" || ch === "|" || (ch === "&" && command[i + 1] !== ">")) {
      // `&&`, `||`, `|`, `&` end the segment (`&>` is a redirect, handled below).
      pushSegment();
      if ((ch === "&" || ch === "|") && command[i + 1] === ch) i++;
      continue;
    }
    if (ch === "&" && command[i + 1] === ">") continue; // `&>file`
    if (ch === ">") {
      // `2>`, `>>`, `&>`: the next word is a write target (unless it is `&1`).
      pushToken();
      while (command[i + 1] === ">") i++;
      if (command[i + 1] === "&") {
        i++;
        while (/[0-9-]/.test(command[i + 1] ?? "")) i++;
        continue;
      }
      pendingRedirect = true;
      continue;
    }
    current += ch;
    has = true;
  }
  if (quote) return undefined;
  pushSegment();
  return segments;
}

const DESTRUCTIVE_WORD =
  /\b(rm|rmdir|unlink|shred|del|erase|rd|mv|move|remove-item|move-item|ri|mi|format|diskpart|mkfs[\w.]*|dd|reg|bcdedit|vssadmin|cipher|git\s+push)\b/i;

const WRAPPERS = new Set(["sudo", "command", "builtin", "exec", "nohup", "time", "env"]);
const DELETE_OR_MOVE = new Set([
  "rm", "rmdir", "unlink", "shred", "del", "erase", "rd", "mv", "move",
  "remove-item", "ri", "move-item", "mi",
]); // prettier-ignore
const SHELL_WRAPPERS = new Set(["bash", "sh", "zsh", "cmd", "powershell", "pwsh"]);
const PS_VALUE_PARAMS = new Set(["-filter", "-include", "-exclude", "-credential", "-stream"]);
const PS_PATH_PARAMS = new Set(["-path", "-literalpath", "-destination"]);
const NULL_SINKS = new Set(["/dev/null", "nul", "$null", "/dev/stdout", "/dev/stderr"]);

export function commandName(token: string): string {
  const base = token.replace(/^.*[\\/]/, "").toLowerCase();
  return base.endsWith(".exe") ? base.slice(0, -4) : base;
}

export function expandHome(arg: string, env: BoundaryEnv): string | undefined {
  const home = env.home ?? process.env.HOME ?? process.env.USERPROFILE ?? "";
  const tmp = env.tmp ?? tmpdir();
  let out = arg
    .replace(/^\$\{?HOME\}?(?=$|[\\/])/u, home)
    .replace(/^%USERPROFILE%/iu, home)
    .replace(/^\$env:USERPROFILE/iu, home)
    .replace(
      /^(?:\$\{?(?:TMPDIR|TMP|TEMP)\}?|%(?:TMP|TEMP)%|\$env:(?:TMP|TEMP))(?=$|[\\/])/iu,
      tmp,
    );
  // Git Bash mounts the Windows temp dir (%TEMP%) at /tmp.
  if (platformOf(env) === "win32" && /^\/tmp(?=$|\/)/u.test(out)) out = tmp + out.slice(4);
  if (/[$`%]/u.test(out)) return undefined; // a variable we can't resolve
  // Globs: judge the folder they expand in.
  const glob = out.search(/[*?[]/u);
  if (glob >= 0) {
    const head = out.slice(0, glob);
    out = /[\\/]$/u.test(head) || head === "" ? head || "." : dirname(head);
  }
  return out;
}

type Outside = { reason: "move" | "write" | "unsure"; path?: string };

function operandOutside(
  arg: string,
  cwd: string | undefined,
  env: BoundaryEnv,
): Outside | undefined {
  const expanded = expandHome(arg, env);
  if (expanded === undefined) return { reason: "unsure" };
  const absolute =
    expanded.startsWith("/") ||
    expanded.startsWith("~") ||
    /^[A-Za-z]:/u.test(expanded) ||
    expanded.startsWith("\\\\");
  if (!absolute && cwd === undefined) return { reason: "unsure" };
  // A drive-letter path where there are no drives can't be inside the project.
  if (/^[A-Za-z]:[\\/]/u.test(expanded) && platformOf(env) !== "win32") {
    return { reason: "move", path: expanded };
  }
  const path = resolveToolPath(expanded, cwd ?? env.cwd, platformOf(env), env.home);
  return isInsideRoots(path, env) ? undefined : { reason: "move", path };
}

function operands(name: string, args: string[]): string[] {
  const out: string[] = [];
  const cmdStyle = ["del", "erase", "rd", "move", "rmdir"].includes(name);
  const powershell = name.includes("-item") || name === "ri" || name === "mi";
  let endOfFlags = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!endOfFlags && a === "--") {
      endOfFlags = true;
      continue;
    }
    if (!endOfFlags && powershell && a.startsWith("-")) {
      const p = a.toLowerCase().replace(/:.*$/u, "");
      if (PS_PATH_PARAMS.has(p)) {
        if (a.includes(":")) out.push(a.slice(a.indexOf(":") + 1));
        else if (args[i + 1] !== undefined) out.push(args[++i]!);
      } else if (PS_VALUE_PARAMS.has(p)) i++;
      continue;
    }
    if (!endOfFlags && a.startsWith("-") && a.length > 1) continue;
    if (!endOfFlags && cmdStyle && /^\/[a-z](:.*)?$/iu.test(a)) continue;
    out.push(a);
  }
  return out;
}

function gitForcePush(args: string[]): boolean {
  if (args[0] !== "push") return false;
  return args.some(
    (a) =>
      a === "-f" ||
      a === "--force" ||
      a.startsWith("--force-with-lease") ||
      a === "--mirror" ||
      a === "--delete" ||
      a === "-d" ||
      (/^-[a-z]*f[a-z]*$/u.test(a) && !a.startsWith("--")) ||
      a.startsWith("+"),
  );
}

function systemDestructive(name: string, args: string[]): boolean {
  if (name === "format" || name === "diskpart" || name.startsWith("mkfs") || name === "bcdedit")
    return true;
  if (name === "dd") return args.some((a) => a.startsWith("of="));
  if (name === "reg") return args[0] !== undefined && args[0].toLowerCase() !== "query";
  if (name === "vssadmin") return args.some((a) => a.toLowerCase() === "delete");
  if (name === "cipher") return args.some((a) => a.toLowerCase().startsWith("/w"));
  return false;
}

/** bash: one question for the whole command, or none. */
export function classifyBash(command: string, env: BoundaryEnv): BoundaryVerdict {
  const ask = (what: string): BoundaryVerdict => ({
    ask: true,
    question: `Агент хочет ${what}:\n${command.length > 300 ? `${command.slice(0, 300)}…` : command}\n${QUESTION_TAIL}`,
    key: `bash:${command}`,
  });
  const destructiveMentioned = DESTRUCTIVE_WORD.test(command);
  // Things we cannot follow: judge only by the words in them.
  if (/\$\(|`|<\(|\beval\b|\bxargs\b/u.test(command) && destructiveMentioned) {
    return ask("выполнить команду, последствия которой не удаётся проверить");
  }
  const segments = splitCommand(command);
  if (!segments) {
    return destructiveMentioned
      ? ask("выполнить команду, последствия которой не удаётся проверить")
      : { ask: false };
  }
  let cwd: string | undefined = env.cwd;
  for (const { tokens, redirects } of segments) {
    for (const target of redirects) {
      if (NULL_SINKS.has(target.toLowerCase())) continue;
      const out = operandOutside(target, cwd, env);
      if (out) return ask("записать файл вне проекта");
    }
    let i = 0;
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[i]!)) i++;
    while (i < tokens.length && WRAPPERS.has(commandName(tokens[i]!))) i++;
    if (i >= tokens.length) continue;
    const name = commandName(tokens[i]!);
    const args = tokens.slice(i + 1);
    if (name === "cd" || name === "pushd" || name === "set-location") {
      const dest = args.find((a) => !a.startsWith("-"));
      const expanded = dest === undefined ? env.home : expandHome(dest, env);
      cwd =
        expanded === undefined
          ? undefined
          : resolveToolPath(expanded, cwd ?? env.cwd, platformOf(env), env.home);
      continue;
    }
    if (SHELL_WRAPPERS.has(name)) {
      const inner = args.find((a, k) => k > 0 && /^(-c|\/c|-command|-c)$/iu.test(args[k - 1]!));
      if (inner !== undefined) {
        const verdict = classifyBash(inner, { ...env, cwd: cwd ?? env.cwd });
        if (verdict.ask) return ask("выполнить команду, которая меняет файлы вне проекта");
        continue;
      }
      if (destructiveMentioned)
        return ask("выполнить команду, последствия которой не удаётся проверить");
      continue;
    }
    if (name === "git" && gitForcePush(args)) {
      return ask("принудительно отправить изменения в git (git push --force)");
    }
    if (systemDestructive(name, args)) return ask("выполнить опасную системную команду");
    if (name === "find" && args.some((a) => a === "-delete" || a === "-exec" || a === "-execdir")) {
      const roots = args.slice(
        0,
        Math.max(
          0,
          args.findIndex((a) => a.startsWith("-")),
        ),
      );
      for (const root of roots.length ? roots : ["."]) {
        if (operandOutside(root, cwd, env)) return ask("удалить файлы вне проекта");
      }
      continue;
    }
    if (DELETE_OR_MOVE.has(name)) {
      for (const operand of operands(name, args)) {
        if (operandOutside(operand, cwd, env)) {
          const deletes = !["mv", "move", "move-item", "mi"].includes(name);
          return ask(deletes ? "удалить файлы вне проекта" : "переместить файлы вне проекта");
        }
      }
    }
  }
  return { ask: false };
}
