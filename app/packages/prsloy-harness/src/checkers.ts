// Быстрые проверки синтаксиса по типу файла. Без сети, только встроенные Node/Python.
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";

export interface CheckResult {
  ok: boolean;
  /** Чем проверяли — для строки в результате тула. */
  tool: string;
  message?: string | undefined;
}

export interface CheckerEnv {
  nodePath?: string | undefined;
  pythonPath?: string | undefined;
  /** Для тестов: подменить загрузку typescript. */
  loadTypeScript?: () => TypeScriptLike | undefined;
  timeoutMs?: number;
}

/** Минимум API typescript, который нужен для проверки синтаксиса. */
export interface TypeScriptLike {
  transpileModule(
    input: string,
    options: {
      fileName?: string;
      reportDiagnostics?: boolean;
      compilerOptions?: Record<string, unknown>;
    },
  ): { diagnostics?: readonly DiagnosticLike[] };
  flattenDiagnosticMessageText(message: unknown, newLine: string): string;
  JsxEmit: { Preserve: number };
}

interface DiagnosticLike {
  messageText: unknown;
  start?: number;
  file?: { getLineAndCharacterOfPosition(pos: number): { line: number; character: number } };
}

const require = createRequire(import.meta.url);

function defaultLoadTypeScript(): TypeScriptLike | undefined {
  try {
    return require("typescript") as TypeScriptLike;
  } catch {
    return undefined;
  }
}

interface RunResult {
  code: number | null;
  output: string;
  spawnError?: string;
}

function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<RunResult> {
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    const onData = (data: Buffer) => {
      if (output.length < 16 * 1024) output += data.toString("utf8");
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, output, spawnError: error.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

/** Сокращает вывод node/python до сути: строка с файлом и сообщение об ошибке. */
function firstLines(text: string, max = 6): string {
  return text
    .replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "") // цвета node
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0 && !/^\s*at\s|^Node\.js v/.test(line))
    .slice(0, max)
    .join("\n");
}

async function nodeCheck(path: string, env: CheckerEnv): Promise<CheckResult> {
  const node = env.nodePath ?? process.execPath;
  const result = await run(
    node,
    ["--check", path],
    { ...process.env, ELECTRON_RUN_AS_NODE: "1", NO_COLOR: "1", FORCE_COLOR: "0" },
    env.timeoutMs ?? 10_000,
  );
  if (result.spawnError)
    return { ok: true, tool: "node --check", message: `не запустился: ${result.spawnError}` };
  if (result.code === 0) return { ok: true, tool: "node --check" };
  return { ok: false, tool: "node --check", message: firstLines(result.output) };
}

const ESM_SYNTAX =
  /^\s*(?:import\s*[\w{*"'(]|export\s+(?:default|const|let|var|function|class|async|\{|\*))/m;

export async function checkJs(path: string, source: string, env: CheckerEnv): Promise<CheckResult> {
  const result = await nodeCheck(path, env);
  // Node 22: `--check` для .js с import/export без "type": "module" молча возвращает 0, не разбирая файл.
  // Такой файл проверяем ещё раз как .mjs.
  if (!result.ok || !/\.js$/i.test(path) || !ESM_SYNTAX.test(source)) return result;
  const dir = await mkdtemp(join(tmpdir(), "prsloy-check-"));
  const copy = join(dir, `${basename(path, extname(path))}.mjs`);
  try {
    await writeFile(copy, source);
    const esm = await nodeCheck(copy, env);
    return esm.ok ? esm : { ...esm, message: esm.message?.split(copy).join(path) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function tsDiagnostics(ts: TypeScriptLike, source: string, fileName: string): string | undefined {
  const out = ts.transpileModule(source, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: { jsx: ts.JsxEmit.Preserve, allowJs: true, noEmit: false },
  });
  const diagnostics = out.diagnostics ?? [];
  if (diagnostics.length === 0) return undefined;
  return diagnostics
    .slice(0, 3)
    .map((d) => {
      const pos =
        d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : undefined;
      const where = pos ? `${basename(fileName)}:${pos.line + 1}:${pos.character + 1}: ` : "";
      return `${where}${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`;
    })
    .join("\n");
}

export async function checkTs(
  path: string,
  source: string,
  env: CheckerEnv,
): Promise<CheckResult | undefined> {
  const ts = (env.loadTypeScript ?? defaultLoadTypeScript)();
  if (ts) {
    const message = tsDiagnostics(ts, source, path);
    return message ? { ok: false, tool: "typescript", message } : { ok: true, tool: "typescript" };
  }
  // Без typescript: встроенное в Node удаление типов (Node ≥ 22.13), только .ts/.mts/.cts — JSX оно не понимает.
  if (/\.[jt]sx$/i.test(path)) return undefined;
  const mod = (await import("node:module")) as { stripTypeScriptTypes?: (code: string) => string };
  if (typeof mod.stripTypeScriptTypes !== "function") return undefined;
  try {
    mod.stripTypeScriptTypes(source);
    return { ok: true, tool: "node strip-types" };
  } catch (error) {
    return {
      ok: false,
      tool: "node strip-types",
      message:
        error instanceof Error ? error.message.split("\n").slice(0, 6).join("\n") : String(error),
    };
  }
}

/** Конфиги, где комментарии и висячие запятые разрешены (JSONC). */
const JSONC_NAME =
  /^(?:(?:tsconfig|jsconfig)(?:\.[\w-]+)*\.json|devcontainer\.json|\.devcontainer\.json|\.eslintrc(?:\.json)?|\.babelrc(?:\.json)?|\.swcrc|biome\.json|turbo\.json|deno\.json|nx\.json|project\.json|.*\.code-workspace|.*\.jsonc)$/i;
const JSONC_DIR = /[\\/]\.(?:vscode|devcontainer|zed)[\\/]/;

/**
 * Убирает комментарии и висячие запятые, не трогая строки. Вырезанное заменяется пробелами
 * (переводы строк остаются), чтобы позиция ошибки JSON.parse указывала на ту же строку исходника.
 */
export function stripJsonc(text: string): string {
  const out: string[] = [];
  const blank = (chunk: string) => chunk.replace(/[^\n]/g, " ");
  let lastSignificant = -1;
  let i = 0;
  while (i < text.length) {
    const ch = text[i] ?? "";
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out.push(text.slice(i, j + 1));
      lastSignificant = out.length - 1;
      i = j + 1;
    } else if (ch === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      const stop = end < 0 ? text.length : end;
      out.push(blank(text.slice(i, stop)));
      i = stop;
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      out.push(blank(text.slice(i, stop)));
      i = stop;
    } else {
      if ((ch === "}" || ch === "]") && lastSignificant >= 0 && out[lastSignificant] === ",") {
        out[lastSignificant] = " ";
      }
      out.push(ch);
      if (!/\s/.test(ch)) lastSignificant = out.length - 1;
      i++;
    }
  }
  return out.join("");
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

export function checkJson(path: string, source: string): CheckResult {
  const text = source.replace(/^\uFEFF/, "");
  const jsonc = JSONC_NAME.test(basename(path)) || JSONC_DIR.test(path);
  try {
    JSON.parse(jsonc ? stripJsonc(text) : text);
    return { ok: true, tool: "JSON.parse" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const pos = /position (\d+)/.exec(message);
    const where = pos ? ` (строка ${lineOf(text, Number(pos[1]))})` : "";
    return { ok: false, tool: "JSON.parse", message: `${message}${where}` };
  }
}

const PY_CHECK =
  "import sys\nsrc=open(sys.argv[1],'rb').read()\ncompile(src, sys.argv[1], 'exec', dont_inherit=True)";

/** Кандидаты на Python: явный путь, потом PATH. На Windows `python` бывает заглушкой Store — её отсекаем. */
function pythonCandidates(env: CheckerEnv): string[][] {
  if (env.pythonPath) return [[env.pythonPath]];
  return process.platform === "win32" ? [["py", "-3"], ["python"]] : [["python3"], ["python"]];
}

export async function checkPython(path: string, env: CheckerEnv): Promise<CheckResult | undefined> {
  for (const [command, ...prefix] of pythonCandidates(env)) {
    if (!command) continue;
    // То же, что `python -m py_compile`, но без записи __pycache__ в проект.
    const result = await run(
      command,
      [...prefix, "-I", "-B", "-c", PY_CHECK, path],
      process.env,
      env.timeoutMs ?? 10_000,
    );
    if (result.spawnError || result.code === 9009 || /Microsoft Store/i.test(result.output))
      continue;
    if (result.code === 0) return { ok: true, tool: "python compile" };
    const lines = result.output
      .split(/\r?\n/)
      .filter((l) => l.trim() && !l.startsWith("Traceback"));
    const relevant = lines
      .filter((l) => !/^\s+File "<string>"/.test(l))
      .slice(-4)
      .join("\n");
    return { ok: false, tool: "python compile", message: relevant || firstLines(result.output) };
  }
  return undefined;
}

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
  "keygen",
  "!doctype",
]);
/** Теги, закрывающий тег которых по стандарту можно опустить. */
const OPTIONAL_CLOSE = new Set([
  "html",
  "head",
  "body",
  "p",
  "li",
  "dt",
  "dd",
  "option",
  "optgroup",
  "rb",
  "rt",
  "rtc",
  "rp",
  "tr",
  "td",
  "th",
  "thead",
  "tbody",
  "tfoot",
  "colgroup",
  "caption",
]);
const RAW_TEXT = new Set(["script", "style", "textarea", "title"]);
const FOREIGN = new Set(["svg", "math"]);

const TAG =
  /<(\/?)([a-zA-Z][\w:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/g;

/** Минимальная проверка баланса тегов: незакрытые и лишние закрывающие. */
export function checkHtml(source: string): CheckResult {
  // Комментарии заменяем пробелами той же длины, чтобы номера строк не съехали.
  const text = source.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, (m) =>
    m.replace(/[^\n]/g, " "),
  );
  const stack: { name: string; line: number }[] = [];
  const problems: string[] = [];
  TAG.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG.exec(text)) && problems.length < 3) {
    const closing = match[1] === "/";
    const name = (match[2] ?? "").toLowerCase();
    const selfClosing = match[4] === "/";
    const line = lineOf(text, match.index);
    if (!closing) {
      if (VOID_TAGS.has(name)) continue;
      // В HTML «/>» у обычного тега ничего не закрывает; в svg/math закрывает.
      const foreign = stack.some((open) => FOREIGN.has(open.name)) || FOREIGN.has(name);
      if (selfClosing && foreign) continue;
      if (selfClosing && RAW_TEXT.has(name)) {
        problems.push(`<${name} …/> не закрывается в HTML — нужен </${name}> (строка ${line})`);
        continue;
      }
      if (RAW_TEXT.has(name)) {
        const end = text.toLowerCase().indexOf(`</${name}`, TAG.lastIndex);
        if (end < 0) {
          problems.push(`не закрыт <${name}> (строка ${line})`);
          break;
        }
        TAG.lastIndex = end;
        stack.push({ name, line });
        continue;
      }
      stack.push({ name, line });
      continue;
    }
    if (VOID_TAGS.has(name)) continue;
    const at = stack.map((s) => s.name).lastIndexOf(name);
    if (at < 0) {
      if (!OPTIONAL_CLOSE.has(name)) problems.push(`лишний </${name}> (строка ${line})`);
      continue;
    }
    for (const open of stack.splice(at).slice(1)) {
      if (!OPTIONAL_CLOSE.has(open.name))
        problems.push(
          `не закрыт <${open.name}> (строка ${open.line}) до </${name}> (строка ${line})`,
        );
    }
  }
  for (const open of stack) {
    if (problems.length >= 3) break;
    if (!OPTIONAL_CLOSE.has(open.name))
      problems.push(`не закрыт <${open.name}> (строка ${open.line})`);
  }
  return problems.length
    ? { ok: false, tool: "баланс тегов", message: problems.join("\n") }
    : { ok: true, tool: "баланс тегов" };
}

/**
 * Запасная проверка CSS без зависимостей: незакрытые комментарии, строки и скобки. Нужна, если postcss
 * не загрузился (он CommonJS, и в ESM-бандле без require падает на require("fs")).
 */
export function checkCssBalance(source: string): CheckResult {
  const tool = "баланс скобок CSS";
  const stack: { ch: string; line: number }[] = [];
  const pairs: Record<string, string> = { "}": "{", ")": "(", "]": "[" };
  let line = 1;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i] ?? "";
    if (ch === "\n") line++;
    else if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end < 0) return { ok: false, tool, message: `не закрыт комментарий /* (строка ${line})` };
      line += source.slice(i, end).split("\n").length - 1;
      i = end + 1;
    } else if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== ch && source[j] !== "\n")
        j += source[j] === "\\" ? 2 : 1;
      if (source[j] !== ch)
        return { ok: false, tool, message: `не закрыта строка ${ch} (строка ${line})` };
      i = j;
    } else if (ch === "{" || ch === "(" || ch === "[") stack.push({ ch, line });
    else if (ch in pairs) {
      const open = stack.pop();
      if (!open || open.ch !== pairs[ch]) {
        return { ok: false, tool, message: `лишняя «${ch}» (строка ${line})` };
      }
    }
  }
  const open = stack.pop();
  return open
    ? { ok: false, tool, message: `не закрыта «${open.ch}» (строка ${open.line})` }
    : { ok: true, tool };
}

export async function checkCss(path: string, source: string): Promise<CheckResult> {
  let postcss: { parse(css: string, opts: { from: string }): unknown };
  try {
    postcss = (await import("postcss")).default;
  } catch {
    return checkCssBalance(source);
  }
  try {
    postcss.parse(source, { from: path });
    return { ok: true, tool: "postcss" };
  } catch (error) {
    const e = error as {
      name?: string;
      reason?: string;
      line?: number;
      column?: number;
      message?: string;
    };
    // Не синтаксическая ошибка, а сам postcss не работает в этом окружении (например, require в бандле).
    if (e.name !== "CssSyntaxError") return checkCssBalance(source);
    const where = e.line ? `${basename(path)}:${e.line}:${e.column ?? 0}: ` : "";
    return {
      ok: false,
      tool: "postcss",
      message: `${where}${e.reason ?? e.message ?? String(error)}`,
    };
  }
}

/** Проверка по расширению. undefined — тип не проверяем или нечем. */
export async function checkFile(
  path: string,
  source: string,
  env: CheckerEnv = {},
): Promise<CheckResult | undefined> {
  const ext = extname(path).toLowerCase();
  switch (ext) {
    case ".js":
    case ".mjs":
    case ".cjs": {
      const result = await checkJs(path, source, env);
      // В .js часто лежит JSX (React) — node его не понимает. Перепроверяем парсером typescript.
      if (!result.ok && /<[A-Za-z][\w.]*[\s>/]/.test(source)) {
        const ts = await checkTs(path.replace(/\.[cm]?js$/i, ".jsx"), source, env);
        if (ts?.ok) return ts;
      }
      return result;
    }
    case ".jsx":
    case ".ts":
    case ".mts":
    case ".cts":
    case ".tsx":
      return checkTs(path, source, env);
    case ".json":
    case ".jsonc":
      return checkJson(path, source);
    case ".py":
      return checkPython(path, env);
    case ".html":
    case ".htm":
      return checkHtml(source);
    case ".css":
      return checkCss(path, source);
    default:
      return undefined;
  }
}
