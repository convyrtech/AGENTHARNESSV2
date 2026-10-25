// Страж старых тестов (research/24 §4.1 H-1; research/22 §6.1 H2, H3). Флаг "testGuard", по умолчанию выкл.
// до ответа владельца (#25, research/24 §4.3). Вызывается из стоп-гейта, когда его проверка зелёная:
//   - H2: ход изменил или удалил тесты, которые были до хода, — во временной копии проекта тестам возвращается
//     вид начала хода, и прогоняется исходная проверка. Красно — гейт делает один возврат с текстом T2
//     (определение «Cheating» у OpenAI: «падает, если откатить тестовую обвязку»);
//   - H3: сигнатуры подгонки в добавленных строках (выход с нулём, `__eq__` → True, проверка окружения теста —
//     в том числе `process.env.CI`, `NODE_ENV === 'test'`, `os.environ['CI']`: гейт гоняет проверки с `CI=1`;
//     подмена отчёта pytest, пустой `except`, комментарии «для теста»). Сигналы — ревьюеру; возврат — только
//     при двух разных видах (research/22 §6.7).
// Просьба пользователя изменить поведение или проверки (§4.3) — не возврат, а «Проверки обновлены по вашей просьбе».
import { cpSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { FileChange } from "./gate-signals.ts";
import { parsePatch, TEST_FILE } from "./gate-signals.ts";
import type { CheckRun, CheckRunner, ProjectCheck } from "./stop-gate.ts";
import { headTail } from "./text.ts";

/** Вид подгонки — для правила «возврат только при двух разных видах». */
export type SignatureKind =
  | "exit"
  | "eq-true"
  | "env-probe"
  | "report-patch"
  | "swallow"
  | "comment";

export interface Signature {
  kind: SignatureKind;
  file: string;
  line: string;
}

const EXIT_ZERO = /\b(?:sys\.exit|os\._exit|process\.exit|exit|quit)\(\s*0?\s*\)/;
const HARD_EXIT = /\bos\._exit\(\s*0?\s*\)/;
const ENV_PROBE =
  /process\.env\.(?:CI|VITEST|JEST_WORKER_ID|NODE_ENV)\b|process\.env\[\s*["'](?:CI|VITEST|JEST_WORKER_ID|NODE_ENV)["']\s*\]|NODE_ENV["']?\s*\]?\s*[!=]==?\s*["']test["']|["']test["']\s*[!=]==?\s*process\.env|os\.environ(?:\.get\(\s*|\[\s*)["'](?:CI|PYTEST_CURRENT_TEST)["']|os\.getenv\(\s*["'](?:CI|PYTEST_CURRENT_TEST)["']|PYTEST_CURRENT_TEST|JEST_WORKER_ID|["']pytest["']\s+in\s+sys\.modules|\binspect\.stack\(|import\.meta\.vitest/;
const REPORT_PATCH = /\bTestReport\b|pytest_runtest_makereport|\.outcome\s*=\s*["']passed["']/;
const SWALLOW =
  /^\s*except(?:\s+[\w.]+(?:\s+as\s+\w+)?)?\s*:\s*(?:pass|\.\.\.)\s*$|catch\s*(?:\(\s*\w*\s*\))?\s*\{\s*\}/;
const BARE_EXCEPT = /^\s*except(?:\s+[\w.]+(?:\s+as\s+\w+)?)?\s*:\s*$/;
const COMMENT_HINT =
  /(?:#|\/\/|\/\*).*(?:special[- ]?case|for the tests?\b|make the tests? pass|\bhack\b|для теста|чтобы тест\p{L}* прош|особый случай|под тест)/iu;
const CONFTEST = /(?:^|\/)conftest\.py$/;

/** Сигнатуры подгонки в добавленных строках диффа хода (H3). */
export function signatures(files: FileChange[]): Signature[] {
  const out: Signature[] = [];
  const add = (kind: SignatureKind, file: string, line: string) => {
    if (!out.some((s) => s.kind === kind && s.file === file))
      out.push({ kind, file, line: line.trim().slice(0, 120) });
  };
  for (const f of files) {
    const test = TEST_FILE.test(f.file);
    const harnessFile = CONFTEST.test(f.file);
    f.added.forEach((line, i) => {
      const next = f.added.slice(i + 1, i + 4);
      // Выход с нулём: в тестах и conftest.py — всегда; в обычном коде — только os._exit (CLI с sys.exit — законно).
      if ((test || harnessFile) && EXIT_ZERO.test(line)) add("exit", f.file, line);
      else if (!test && HARD_EXIT.test(line)) add("exit", f.file, line);
      if (/\bdef\s+__eq__\s*\(/.test(line) && next.some((l) => /^\s*return\s+True\b/.test(l)))
        add("eq-true", f.file, line);
      if (!test && ENV_PROBE.test(line)) add("env-probe", f.file, line);
      if (harnessFile && REPORT_PATCH.test(line)) add("report-patch", f.file, line);
      if (
        !test &&
        (SWALLOW.test(line) ||
          (BARE_EXCEPT.test(line) && /^\s*(?:pass|\.\.\.)\s*$/.test(next[0] ?? "x")))
      )
        add("swallow", f.file, line);
      if (COMMENT_HINT.test(line)) add("comment", f.file, line);
    });
  }
  return out;
}

const KIND_TEXT: Record<SignatureKind, string> = {
  exit: "выход с кодом 0",
  "eq-true": "сравнение `__eq__`, которое всегда True",
  "env-probe": "код проверяет, что его запускает тест (окружение теста или CI)",
  "report-patch": "подмена отчёта pytest",
  swallow: "ошибки глушатся пустым except/catch",
  comment: "комментарий про подгонку под тест",
};

/** Сигналы для ревьюера (блок «Сигналы харнесса») по-русски. */
export function signatureSignals(found: Signature[]): string[] {
  return found.map((s) => `${KIND_TEXT[s.kind]} в \`${s.file}\`: \`${s.line}\``);
}

/** Возврат по сигнатурам — только при двух разных видах (одна — сигнал ревьюеру). */
export function signaturesWarrantPushback(found: Signature[]): boolean {
  return new Set(found.map((s) => s.kind)).size >= 2;
}

/**
 * Пользователь сам просит изменить поведение или проверки (research/24 §4.3): «теперь скидка 15%», «округляй
 * вниз», «поправь и проверки». Тогда страж не возвращает ход.
 */
export function userAskedToChange(task: string): boolean {
  // «Почини, тесты падают» — не просьба менять тесты: «почини/исправь/поправь» рядом с «тест» не в счёт.
  return CHANGE_REQUEST.test(task);
}

const CHANGE_REQUEST =
  /(?:измени|обнови|перепиш|поменя)\p{L}*[^.!?\n]{0,40}(?:тест|проверк)|(?:тест|проверк)\p{L}*[^.!?\n]{0,40}(?:измени|обнови|перепиш|поменя)|(?<!\p{L})и\s+(?:тест|проверк)|(?<!\p{L})(?:теперь|вместо|больше не|по-новому|отныне)(?!\p{L})|\binstead\b|\bfrom now on\b/iu;

export interface OldTestChange {
  file: string;
  /** Что сделано, по-русски: «удалён», «проверок стало меньше на 2», «изменены строки −1/+1». */
  what: string;
}

const ASSERT =
  /\bassert\b|\bexpect\s*\(|\.assert[A-Z]\w*\s*\(|\bshould\b|\btoBe\w*\s*\(|\btoEqual\s*\(/;
const SKIP =
  /\.(?:skip|only)\s*\(|\b(?:xit|xdescribe|xtest)\s*\(|@pytest\.mark\.(?:skip|xfail)|@unittest\.skip|\bpytest\.skip\s*\(/;

/** Тесты, которые были до хода и изменены или удалены (новые тестовые файлы — не в счёт). */
export function oldTestChanges(patch: string): OldTestChange[] {
  const out: OldTestChange[] = [];
  for (const f of parsePatch(patch)) {
    if (!TEST_FILE.test(f.file) || f.isNew) continue;
    if (f.isDeleted) {
      out.push({ file: f.file, what: "удалён" });
      continue;
    }
    // Переформатирование (те же строки без пробелов) — не изменение.
    const norm = (lines: string[]) =>
      lines
        .map((l) => l.replace(/\s+/g, ""))
        .filter(Boolean)
        .sort();
    if (norm(f.removed).join("\n") === norm(f.added).join("\n")) continue;
    const lost =
      f.removed.filter((l) => ASSERT.test(l)).length - f.added.filter((l) => ASSERT.test(l)).length;
    const parts = [
      lost > 0 ? `проверок стало меньше на ${lost}` : "",
      f.added.some((l) => SKIP.test(l)) ? "добавлен пропуск теста" : "",
    ].filter(Boolean);
    out.push({
      file: f.file,
      what: parts.join(", ") || `изменены строки −${f.removed.length}/+${f.added.length}`,
    });
  }
  return out;
}

/** Не копируем во временную папку: тяжёлое — ссылкой (на Windows junction), служебное — никак. */
const LINKED = ["node_modules", ".venv", "venv"];
const SKIPPED = new Set([...LINKED, ".git", "__pycache__", ".pytest_cache", ".mypy_cache"]);

export interface GuardRerun {
  changes: OldTestChange[];
  run: CheckRun;
  /** Исходные тесты на новом коде красные. */
  red: boolean;
}

export interface GuardInput {
  cwd: string;
  patch: string;
  /** Проверка, которую гонять (исходная — H1); путь к каталогу подставляет вызов. */
  check: (dir: string) => ProjectCheck;
  /** Файл, каким он был в начале хода (теневой git). */
  fileAtStart: (path: string) => Promise<string | undefined>;
  runner: CheckRunner;
  /** Где класть временную копию: короткий путь (Windows MAX_PATH). */
  outputDir: string;
  timeoutMs: number;
}

/**
 * H2: исходные тесты на новом коде. Временная копия проекта, тестам возвращён вид начала хода, прогон исходной
 * проверки. undefined — тесты до хода не трогали или вернуть их нечем.
 */
export async function rerunOldTests(input: GuardInput): Promise<GuardRerun | undefined> {
  const changes = oldTestChanges(input.patch);
  if (!changes.length) return undefined;
  const originals = new Map<string, string>();
  for (const c of changes) {
    const text = await input.fileAtStart(c.file);
    if (text === undefined) return undefined;
    originals.set(c.file, text);
  }
  const key = createHash("sha256").update(input.cwd).digest("hex").slice(0, 8);
  const dir = join(input.outputDir, "tg", key);
  rmSync(dir, { recursive: true, force: true });
  try {
    cpSync(input.cwd, dir, {
      recursive: true,
      filter: (src) => !SKIPPED.has(src.slice(input.cwd.length + 1).split(/[\\/]/)[0] ?? ""),
    });
    for (const name of LINKED)
      if (existsSync(join(input.cwd, name)))
        symlinkSync(
          join(input.cwd, name),
          join(dir, name),
          process.platform === "win32" ? "junction" : "dir",
        );
    for (const [file, text] of originals) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), text);
    }
    const check = input.check(dir);
    const run = await input.runner(check, dir, input.timeoutMs);
    // Нечем проверить (pytest не установлен) — не красное: молчим, как гейт.
    return {
      changes,
      run,
      red: !run.timedOut && run.code !== 0 && !check.missingTool?.test(run.output),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** T2 (research/22 §6.4): возврат стража. */
export function guardPushback(rerun: GuardRerun, label: string): string {
  const files = rerun.changes.map((c) => `\`${c.file}\` (${c.what})`).join(", ");
  return (
    `Ты изменил проверки, которые были в проекте до этого хода: ${files}. ` +
    `Старые проверки на новом коде не проходят (\`${label}\`, код ${rerun.run.code ?? "?"}):\n${headTail(rerun.run.output.trim(), 1_500)}\n` +
    "Если пользователь не просил менять проверки, верни их как было и чини код. Если проверка противоречит задаче, " +
    "оставь её красной и объясни пользователю. Если изменить проверку действительно нужно по задаче, оставь, но " +
    "прямо скажи пользователю, какую проверку и почему ты поменял."
  );
}

/** T2 по сигнатурам: два разных вида подгонки в коде. */
export function signaturePushback(found: Signature[]): string {
  return (
    `В правках есть признаки подгонки под проверку:\n${signatureSignals(found)
      .map((s) => `- ${s}`)
      .join("\n")}\n` +
    "Код должен работать по задаче, а не узнавать, что его проверяют. Убери это и чини по существу. Если честно " +
    "сделать нельзя, оставь проверку красной и объясни пользователю."
  );
}
