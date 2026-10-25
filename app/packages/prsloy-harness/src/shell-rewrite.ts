// Разбор bash-команды модели: серверы, запущенные через `&`, и pkill/killall/taskkill.
// Источник: живая приёмка №2 (дирижёр, 2026-10-25): DeepSeek и Kimi запускали `(python3 -m http.server 8099 &)`
// мимо реестра, а `pkill -f "http.server 8099"` убивал собственный shell (exit 143): шаблон есть в `bash -c …`.
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { looksLikeServer } from "./process-registry.ts";

export interface BackgroundJob {
  /** Текст фоновой задачи без `&`, как написала модель. */
  raw: string;
  /** Команда для реестра: без nohup/setsid и без перенаправления вывода (лог пишет реестр). */
  command: string;
  start: number;
  /** Индекс символа `&`. */
  end: number;
}

/**
 * Находит задачи, отправленные в фон одиночным `&` (не `&&`, не `2>&1`, не `&>`).
 * В bash `a && b &` уводит в фон весь список, поэтому задача начинается после `;`, перевода строки,
 * предыдущего `&` или открывающей скобки. Возвращает undefined, если кавычки или скобки не сходятся.
 */
export function findBackgroundJobs(command: string): BackgroundJob[] | undefined {
  const jobs: BackgroundJob[] = [];
  const listStart: number[] = [0];
  let quote: "'" | '"' | undefined;
  let subst = 0; // $( … ) и `…` не разбираем: это отдельная команда
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const prev = command[i - 1];
    const next = command[i + 1];
    if (quote) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "$" && next === "(") {
      subst++;
      i++;
      continue;
    }
    if (subst > 0) {
      if (ch === "(") subst++;
      else if (ch === ")") subst--;
      continue;
    }
    if (ch === "#" && (i === 0 || /\s/.test(prev ?? ""))) {
      const nl = command.indexOf("\n", i);
      if (nl < 0) break;
      i = nl - 1;
      continue;
    }
    if (ch === "(" || ch === "{") {
      listStart.push(i + 1);
      continue;
    }
    if (ch === ")" || ch === "}") {
      if (listStart.length <= 1) return undefined;
      listStart.pop();
      continue;
    }
    if (ch === ";" || ch === "\n") {
      listStart[listStart.length - 1] = i + 1;
      continue;
    }
    if (ch === "&") {
      if (next === "&") {
        i++;
        continue;
      }
      if (next === ">" || prev === ">" || prev === "<") continue; // &> file, 2>&1, <&3
      const start = listStart[listStart.length - 1] ?? 0;
      const raw = command.slice(start, i).trim();
      if (raw) {
        const offset = command.indexOf(raw, start);
        jobs.push({ raw, command: cleanJob(raw), start: offset, end: i });
      }
      listStart[listStart.length - 1] = i + 1;
    }
  }
  if (quote || subst > 0 || listStart.length !== 1) return undefined;
  return jobs;
}

/** Убирает nohup/setsid/exec и перенаправления вывода: вывод должен идти в лог реестра. */
export function cleanJob(job: string): string {
  return job
    .replace(/(^|&&|\|\||;)(\s*)(?:(?:nohup|setsid|exec)\s+)+/g, "$1$2")
    .replace(/\s*(?:\d?>>?|&>>?)\s*(?:&\d|"[^"]*"|'[^']*'|[^\s;&|]+)/g, "")
    .trim();
}

/** Долгоживущий скрипт, запущенный в фон: `node server.js &`, `python app.py &`. */
const LONG_RUNNER =
  /^(?:node|nodejs|deno\s+run(?:\s+-\S+)*|bun(?:\s+run)?|python[0-9.]*|php|ruby)\s+(?:\S*\/)?[\w.-]*(?:server|serve|app|index|main|dev|api|backend)[\w.-]*\.(?:m?js|cjs|ts|py|php|rb)(?:\s|$)/i;

export function isBackgroundServer(job: string): boolean {
  return (
    looksLikeServer(job) || job.split(/&&|\|\||;|\|/).some((part) => LONG_RUNNER.test(part.trim()))
  );
}

/**
 * Каталог, в котором запустится задача: применяет `cd X` перед ней. undefined — если cd с переменными
 * или подстановкой (тогда команду не трогаем).
 */
export function cwdBefore(command: string, jobStart: number, cwd: string): string | undefined {
  let dir = cwd;
  const before = command.slice(0, jobStart);
  for (const part of before.split(/&&|\|\||;|\n|\(|\{/)) {
    const match = /^\s*cd(?:\s+(.*?))?\s*$/.exec(part);
    if (!match) continue;
    const arg = (match[1] ?? "~").replace(/^(["'])(.*)\1$/, "$2");
    if (/[$`*?]/.test(arg) || arg === "-") return undefined;
    const expanded =
      arg === "~" ? homedir() : arg.startsWith("~/") ? resolve(homedir(), arg.slice(2)) : arg;
    dir = isAbsolute(expanded) ? expanded : resolve(dir, expanded);
  }
  return dir;
}

/** Заменяет фоновые задачи на `:;` (ничего не делать), остальная команда выполняется как была. */
export function replaceJobs(command: string, jobs: BackgroundJob[]): string {
  let out = command;
  for (const job of [...jobs].sort((a, b) => b.start - a.start)) {
    out = `${out.slice(0, job.start)}:;${out.slice(job.end + 1)}`;
  }
  return out;
}

export interface KillCommand {
  tool: "pkill" | "killall" | "taskkill";
  /** Текст команды в исходной строке. */
  raw: string;
  start: number;
  end: number;
  /** pkill/killall: шаблон или имя; taskkill: имя образа (/IM). */
  target: string | undefined;
  /** pkill -f / pgrep -f: шаблон ищется по всей командной строке, в том числе в `bash -c …` самого тула. */
  fullCommandLine: boolean;
  /** Сигнал для kill (pkill -9, -KILL, --signal X). */
  signal: string | undefined;
  /** Аргументы для pgrep (без сигнала). */
  pgrepArgs: string[];
}

function shellWords(text: string): string[] {
  const words: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  for (const m of text.matchAll(re)) words.push(m[1] ?? m[2] ?? m[3] ?? "");
  return words;
}

/** Ищет pkill/killall/taskkill в начале команд цепочки. */
export function findKillCommands(command: string): KillCommand[] {
  const out: KillCommand[] = [];
  const re =
    /(^|&&|\|\||;|\n|\(|\||\{)(\s*)((?:sudo\s+)?(pkill|killall|taskkill(?:\.exe)?)\b[^;&|\n)]*)/gi;
  for (const m of command.matchAll(re)) {
    const raw = (m[3] ?? "").trimEnd();
    const start = (m.index ?? 0) + (m[1]?.length ?? 0) + (m[2]?.length ?? 0);
    const tool = (m[4] ?? "").toLowerCase().replace(".exe", "") as KillCommand["tool"];
    const words = shellWords(raw).filter((w, i) => !(i === 0 && w === "sudo"));
    const args = words.slice(1);
    let signal: string | undefined;
    let full = false;
    const pgrepArgs: string[] = [];
    let target: string | undefined;
    if (tool === "taskkill") {
      const im = args.findIndex((a) => /^[/-]im$/i.test(a));
      target = im >= 0 ? args[im + 1] : undefined;
    } else {
      for (let i = 0; i < args.length; i++) {
        const a = args[i] ?? "";
        if (a === "--signal" || a === "-s") {
          signal = args[++i];
        } else if (/^-(?:\d+|[A-Z]+|SIG[A-Z]+)$/.test(a)) {
          signal = a.slice(1);
        } else if (a === "-f" || a === "--full") {
          full = true;
          pgrepArgs.push(a);
        } else {
          pgrepArgs.push(a);
          if (!a.startsWith("-")) target = a;
        }
      }
    }
    out.push({
      tool,
      raw,
      start,
      end: start + raw.length,
      target,
      fullCommandLine: full,
      signal,
      pgrepArgs,
    });
  }
  return out;
}

/** Процессы, убийство которых роняет сам тул или приложение. */
const PROTECTED_TARGET =
  /^(?:ba)?sh(?:\.exe)?$|^(?:node|nodejs|electron|prsloy|pi|zeno|bash|mintty|git-bash|conhost)(?:\.exe)?$/i;

export function isProtectedTarget(target: string | undefined): boolean {
  return !!target && PROTECTED_TARGET.test(target);
}

/**
 * pkill -f, который не трогает группу процессов самого тула. Pi запускает bash отдельной группой
 * (detached), поэтому все подоболочки этой команды в ней, а сервер из прошлых вызовов — в чужой.
 */
export const SAFE_PKILL_FUNCTION =
  '__prsloy_pkill() { __sig="$1"; shift; __own=$(ps -o pgid= -p $$ 2>/dev/null | tr -d " "); __n=0; ' +
  'for __p in $(pgrep "$@"); do __g=$(ps -o pgid= -p "$__p" 2>/dev/null | tr -d " "); ' +
  '[ -n "$__own" ] && [ "$__g" = "$__own" ] && continue; kill -"$__sig" "$__p" 2>/dev/null && __n=$((__n+1)); done; [ "$__n" -gt 0 ]; }';

function quoteArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

export function safePkillCall(kill: KillCommand): string {
  return `__prsloy_pkill ${kill.signal ?? "TERM"} ${kill.pgrepArgs.map(quoteArg).join(" ")}`;
}

/** Заменяет куски команды (с конца, чтобы индексы не съехали). */
export function replaceRanges(
  command: string,
  ranges: { start: number; end: number; text: string }[],
): string {
  let out = command;
  for (const r of [...ranges].sort((a, b) => b.start - a.start)) {
    out = `${out.slice(0, r.start)}${r.text}${out.slice(r.end)}`;
  }
  return out;
}
