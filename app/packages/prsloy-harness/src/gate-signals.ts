// Сигналы подгонки под проверки, посчитанные кодом (research/24 §1, research/22 §6.1 H1/H3): для стоп-гейта и
// блока «Сигналы харнесса» во входе ревьюера. Дешёвое подмножество стража тестов (H-1 расширит его в test-guard.ts):
//   - H1: проверка проекта на начало хода против конца — команда пропала или изменилась (`scripts.test` → `echo ok`);
//   - тронуты тесты, которые были до хода (удалены, изменены, добавлены skip/only/xfail);
//   - литерал из тестов в новом условии нетестового кода (`if (price === 200) return 20`) — «особый случай».
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const TEST_FILE =
  /(?:^|\/)(?:tests?|__tests__|spec)\/|(?:^|\/)test_[^/]*\.py$|_test\.py$|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test\.[cm]?[jt]s$|(?:^|\/)tests?\.py$|(?:^|\/)conftest\.py$|(?:^|\/)(?:pytest|tox)\.ini$|(?:^|\/)(?:jest|vitest)\.config\.|(?:^|\/)\.mocharc/;

const SKIP_MARK =
  /\.(?:skip|only)\s*\(|\b(?:xit|xdescribe|xtest)\s*\(|@pytest\.mark\.(?:skip|xfail)|@unittest\.skip|\bpytest\.skip\s*\(/;
export const ASSERT =
  /\bassert\b|\bexpect\s*\(|\.assert[A-Z]\w*\s*\(|\bshould\b|\btoBe\w*\s*\(|\btoEqual\s*\(/;
const CONDITION = /\b(?:if|elif|while|case|when)\b|[!=]==?|\?/;

export interface FileChange {
  file: string;
  isNew: boolean;
  isDeleted: boolean;
  added: string[];
  removed: string[];
}

/** Унифицированный дифф (`git diff`) → изменения по файлам. */
export function parsePatch(patch: string): FileChange[] {
  const out: FileChange[] = [];
  let cur: FileChange | undefined;
  for (const line of patch.split("\n")) {
    const head = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (head) {
      cur = { file: head[2]!, isNew: false, isDeleted: false, added: [], removed: [] };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("new file mode")) cur.isNew = true;
    else if (line.startsWith("deleted file mode")) cur.isDeleted = true;
    else if (line.startsWith("+++") || line.startsWith("---")) continue;
    else if (line.startsWith("+")) cur.added.push(line.slice(1));
    else if (line.startsWith("-")) cur.removed.push(line.slice(1));
  }
  return out;
}

export interface CheckSnapshot {
  /** Команда проверки на начало хода (`detectProjectCheck`), undefined — проверять было нечем. */
  command: string | undefined;
  /** Тела скриптов package.json (test, typecheck, lint) на начало хода. */
  scripts: Record<string, string>;
}

export function packageScripts(cwd: string): Record<string, string> {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    const out: Record<string, string> = {};
    for (const name of ["test", "typecheck", "lint"]) {
      const v = pkg.scripts?.[name];
      if (typeof v === "string") out[name] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Что поменялось в проверке проекта за ход; undefined — ничего. */
export function checkChange(
  start: CheckSnapshot,
  nowCommand: string | undefined,
  nowScripts: Record<string, string>,
): string | undefined {
  if (!start.command) return undefined;
  if (!nowCommand) return `проверка проекта пропала (была \`${start.command}\`)`;
  if (nowCommand !== start.command)
    return `команда проверки изменилась: было \`${start.command}\`, стало \`${nowCommand}\``;
  for (const [name, body] of Object.entries(start.scripts))
    if (nowScripts[name] !== body)
      return `скрипт «${name}» в package.json изменился: было \`${body}\`, стало \`${nowScripts[name] ?? "(удалён)"}\``;
  return undefined;
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  "build",
]);

/** Содержимое тестовых файлов проекта (≤50 файлов, ≤200 КБ) — откуда брать «литералы из тестов». */
export function testTexts(cwd: string): string[] {
  const out: string[] = [];
  let size = 0;
  const walk = (dir: string, depth: number) => {
    if (depth < 0 || out.length >= 50) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (SKIP_DIRS.has(name) || (name.startsWith(".") && name !== ".mocharc")) continue;
      const path = join(dir, name);
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(path, depth - 1);
      else if (
        TEST_FILE.test(relative(cwd, path).replace(/\\/g, "/")) &&
        st.size < 100_000 &&
        size < 200_000
      ) {
        size += st.size;
        out.push(readFileSync(path, "utf8"));
      }
    }
  };
  if (existsSync(cwd)) walk(cwd, 4);
  return out;
}

function literalsOf(line: string): string[] {
  const out: string[] = [];
  const code = line.replace(/\/\/.*$|#.*$/, "");
  for (const m of code.matchAll(/(["'`])([^"'`\n]{2,40})\1/g)) out.push(m[2]!);
  for (const m of code
    .replace(/(["'`])[^"'`\n]*\1/g, " ")
    .matchAll(/(?<![\w.])-?\d+(?:\.\d+)?(?![\w.])/g))
    if (!["0", "1", "-1"].includes(m[0])) out.push(m[0]);
  return out;
}

export interface SignalInput {
  /** Что поменялось в проверке (checkChange). */
  checkChanged?: string | undefined;
  patch: string;
  cwd: string;
  /** Текст задачи пользователя: литералы из него — не особый случай. */
  task: string;
}

/** Сигналы подгонки по-русски для ревьюера и деталей карточки; пусто — признаков нет. */
export function gateSignals(input: SignalInput): string[] {
  const signals: string[] = [];
  if (input.checkChanged) signals.push(input.checkChanged);
  const files = parsePatch(input.patch);
  const tests = files.filter((f) => TEST_FILE.test(f.file) && !f.isNew);
  for (const t of tests) {
    if (t.isDeleted) {
      signals.push(`удалён тест \`${t.file}\`, который был до хода`);
      continue;
    }
    const lost =
      t.removed.filter((l) => ASSERT.test(l)).length - t.added.filter((l) => ASSERT.test(l)).length;
    const skips = t.added.filter((l) => SKIP_MARK.test(l)).length;
    const parts = [
      lost > 0 ? `проверок стало меньше на ${lost}` : "",
      skips > 0 ? `добавлен пропуск теста (skip/only/xfail): ${skips}` : "",
      t.removed.length && lost <= 0 && !skips
        ? `изменены строки: −${t.removed.length}/+${t.added.length}`
        : "",
    ].filter(Boolean);
    if (parts.length)
      signals.push(`изменён тест \`${t.file}\`, который был до хода: ${parts.join(", ")}`);
  }
  // «Особый случай»: литерал из тестов в новом условии нетестового кода, кроме литералов из задачи.
  const testText = [...testTexts(input.cwd), ...tests.flatMap((t) => t.removed)].join("\n");
  if (testText) {
    for (const f of files) {
      if (TEST_FILE.test(f.file)) continue;
      for (const line of f.added) {
        if (!CONDITION.test(line)) continue;
        const hit = literalsOf(line).find(
          (lit) => testText.includes(lit) && !input.task.includes(lit),
        );
        if (hit) {
          signals.push(
            `в новом условии \`${f.file}\` литерал из тестов «${hit}»: \`${line.trim().slice(0, 120)}\``,
          );
          break;
        }
      }
    }
  }
  return signals.slice(0, 8);
}
