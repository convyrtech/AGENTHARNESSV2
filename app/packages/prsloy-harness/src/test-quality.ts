// Полезность новых тестов (H-3, #8; research/22 §4, §6.1 H10; research/24 §4.1). Флаг "testQuality", по умолчанию
// выкл. Боль владельца — «тесты ради тестов». Только сигналы: ревьюеру (блок «Сигналы харнесса») и в статус хода
// (`tests-weak` с файлами), возврата к работе нет.
//   - Статика по тестам, которые ход добавил или поменял: в тесте нет проверок; проверка-тавтология
//     (`assert True`, `expect(x).toBe(x)`); проверяются только вызовы своих же моков; только снимок (snapshot);
//     только тип или «не пусто» (`typeof`, `toBeDefined`, `assert.ok(f())`); тест сразу пропущен (skip).
//   - Fail-to-pass, дешёвая «мутация»: во временной копии код, который ход поменял, возвращается к началу хода, а
//     новые тесты остаются. Проверка зелёная и на старом коде — новые тесты изменения не замечают.
import { parsePatch, TEST_FILE } from "./gate-signals.ts";
import type { CheckRunner, ProjectCheck } from "./stop-gate.ts";
import { runInCopy } from "./test-guard.ts";

export type WeakKind =
  | "no-assert"
  | "tautology"
  | "mock-only"
  | "snapshot-only"
  | "type-only"
  | "skipped";

export interface WeakTest {
  file: string;
  /** Имя теста (`test_total`, «считает скидку»); у файла без блоков — имя файла. */
  name: string;
  kind: WeakKind;
}

const ASSERT_LINE =
  /\bassert\b|\bexpect\s*\(|\bself\.assert\w+\s*\(|\bpytest\.raises\b|\bassert\.\w+\s*\(|\.should\b/;
const TAUTOLOGY = [
  /^\s*assert\s+(?:True|1|not\s+False|1\s*==\s*1|True\s*==\s*True)\s*(?:#.*)?$/,
  /\bassert\s+([\w.[\]"']+)\s*==\s*\1\s*(?:#.*)?$/,
  /\bexpect\(\s*(?:true|1|!0)\s*\)\.to(?:Be|Equal|StrictEqual|BeTruthy)\(\s*(?:true|1)?\s*\)/,
  /\bexpect\(\s*([\w.[\]"']+)\s*\)\.to(?:Be|Equal|StrictEqual)\(\s*\1\s*\)/,
  /\bassert(?:\.ok)?\(\s*true\s*\)/,
  /\bassert\.(?:strict)?(?:[Dd]eep)?[Ee]qual\(\s*([\w.[\]"']+)\s*,\s*\1\s*\)/,
  /\bself\.assert(?:Equal|True)\(\s*(?:True|([\w.[\]"']+)\s*,\s*\1)\s*\)/,
];
const MOCK_ASSERT =
  /\.assert_(?:called\w*|any_call|not_called|has_calls)\b|\.called\b|\.call_count\b|\btoHaveBeenCalled\w*|\btoBeCalled\w*/;
const SNAPSHOT =
  /toMatchSnapshot|toMatchInlineSnapshot|snapshot\.assert_match|assert_match_snapshot|\bsnapshot\s*==/;
const TYPE_ONLY =
  /\btypeof\b|\btoBeDefined\(|\btoBeTruthy\(|\bnot\.toBeNull\(|\bis not None\b|\bisinstance\(|\bassert\.ok\(|\bassertIsNotNone\(|\bassertTrue\(\s*\w+\s*\)/;
const SKIP =
  /\.skip\s*\(|\b(?:xit|xtest|xdescribe)\s*\(|@pytest\.mark\.skip|@unittest\.skip|\bpytest\.skip\s*\(/;

const PY_TEST = /^(\s*)(?:async\s+)?def\s+(test\w*)\s*\(/;
const JS_TEST = /^\s*(?:it|test)(?:\.skip|\.only)?\s*\(\s*(["'`])(.*?)\1/;
const JS_BOUNDARY = /^\s*(?:it|test|describe)(?:\.skip|\.only)?\s*\(/;

interface Block {
  name: string;
  lines: string[];
  skipped: boolean;
}

/** Тесты из добавленных строк: Python — `def test_…` с телом по отступу, JS — `it(…)` / `test(…)` до следующего. */
export function testBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let cur: (Block & { indent?: number }) | undefined;
  lines.forEach((line, i) => {
    const py = PY_TEST.exec(line);
    const js = JS_TEST.exec(line);
    if (py || js) {
      const prev = lines[i - 1] ?? "";
      cur = {
        name: py ? py[2]! : js![2]!,
        // Заголовок — тоже тело: однострочный `it('x', () => { expect(f()).toBe(1); })`.
        lines: [line],
        // Строка выше в счёт только как декоратор Python (`@pytest.mark.skip`), не соседний `it.skip(…)`.
        skipped: SKIP.test(line) || (/^\s*@/.test(prev) && SKIP.test(prev)),
        ...(py ? { indent: py[1]!.length } : {}),
      };
      blocks.push(cur);
      return;
    }
    if (!cur) return;
    if (cur.indent !== undefined) {
      const indent = /^(\s*)/.exec(line)![1]!.length;
      if (line.trim() && indent <= cur.indent) {
        cur = undefined;
        return;
      }
    } else if (JS_BOUNDARY.test(line)) {
      cur = undefined;
      return;
    }
    cur.lines.push(line);
  });
  return blocks;
}

/** `import assert from …`, `const assert = require(…)`, `from x import y` — не проверка. */
const IMPORT_LINE =
  /^\s*(?:import\b|from\s+\S+\s+import\b|(?:const|let|var)\s+[\w{}\s,]+=\s*require\()/;

function classify(block: Block): WeakKind | undefined {
  if (block.skipped) return "skipped";
  const asserts = block.lines.filter(
    (l) => !IMPORT_LINE.test(l) && (ASSERT_LINE.test(l) || MOCK_ASSERT.test(l) || SNAPSHOT.test(l)),
  );
  if (!asserts.length) return "no-assert";
  if (asserts.every((l) => TAUTOLOGY.some((re) => re.test(l)))) return "tautology";
  if (asserts.every((l) => MOCK_ASSERT.test(l))) return "mock-only";
  if (asserts.every((l) => SNAPSHOT.test(l))) return "snapshot-only";
  if (asserts.every((l) => TYPE_ONLY.test(l) || TAUTOLOGY.some((re) => re.test(l))))
    return "type-only";
  return undefined;
}

/** Статика: слабые тесты среди добавленных строк тестовых файлов хода. */
export function weakTests(patch: string): WeakTest[] {
  const out: WeakTest[] = [];
  for (const f of parsePatch(patch)) {
    if (f.isDeleted || !TEST_FILE.test(f.file) || /conftest\.py$|\.ini$|config\./.test(f.file))
      continue;
    const blocks = testBlocks(f.added);
    if (blocks.length) {
      for (const b of blocks) {
        const kind = classify(b);
        if (kind) out.push({ file: f.file, name: b.name, kind });
      }
      continue;
    }
    // Новый файл-скрипт без блоков (`node test.js` с assert-ами): весь файл как один тест.
    if (f.isNew && f.added.some((l) => l.trim())) {
      const kind = classify({ name: f.file, lines: f.added, skipped: false });
      if (kind) out.push({ file: f.file, name: f.file, kind });
    }
  }
  return out;
}

const KIND_TEXT: Record<WeakKind, string> = {
  "no-assert": "в нём нет ни одной проверки",
  tautology: "проверка всегда верна (сравнивает значение с самим собой или с True)",
  "mock-only": "проверяет только вызовы своих же заглушек, а не результат",
  "snapshot-only": "только снимок (snapshot): примет любой результат при первом запуске",
  "type-only": "проверяет только тип или «не пусто», а не значение",
  skipped: "тест сразу пропущен (skip)",
};

export function weakSignals(found: WeakTest[]): string[] {
  return found.map((w) => `новый тест «${w.name}» в \`${w.file}\`: ${KIND_TEXT[w.kind]}`);
}

/** Код и тесты, которые ход менял: что откатить для fail-to-pass. Конфиги и зависимости не трогаем. */
export function codeAndTests(patch: string): {
  code: string[];
  tests: string[];
  newCode: string[];
} {
  const code: string[] = [];
  const newCode: string[] = [];
  const tests: string[] = [];
  for (const f of parsePatch(patch)) {
    if (TEST_FILE.test(f.file)) {
      if (!f.isDeleted) tests.push(f.file);
      continue;
    }
    if (
      /(?:^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|requirements[^/]*\.txt|pyproject\.toml|\.env[^/]*)$/.test(
        f.file,
      )
    )
      continue;
    if (!/\.(?:[cm]?[jt]sx?|py|go|rs|rb|php|java|kt|cs)$/.test(f.file)) continue;
    (f.isNew ? newCode : code).push(f.file);
  }
  return { code, tests, newCode };
}

export interface FailToPass {
  /** Новые тесты прошли и на старом коде: изменения они не замечают. */
  passOnOld: boolean;
  tests: string[];
}

/**
 * Fail-to-pass: код хода откатывается к началу хода (новые файлы кода убираются), тесты остаются новыми.
 * undefined — проверять нечего (ход не менял одновременно код и тесты) или вернуть код нечем.
 */
export async function failToPass(input: {
  cwd: string;
  patch: string;
  check: ProjectCheck;
  fileAtStart: (path: string) => Promise<string | undefined>;
  runner: CheckRunner;
  outputDir: string;
  timeoutMs: number;
}): Promise<FailToPass | undefined> {
  const { code, tests, newCode } = codeAndTests(input.patch);
  if (!tests.length || !(code.length + newCode.length)) return undefined;
  const files = new Map<string, string | null>();
  for (const f of code) {
    const text = await input.fileAtStart(f);
    if (text === undefined) return undefined;
    files.set(f, text);
  }
  for (const f of newCode) files.set(f, null);
  const result = await runInCopy({ ...input, files, check: () => input.check });
  // Красно на старом коде — хорошо: тесты ловят то, что ход изменил. Таймаут и «нечем» — не знаем.
  if (result.run.timedOut) return undefined;
  return { passOnOld: !result.red && result.run.code === 0, tests };
}

export function failToPassSignal(f: FailToPass): string {
  return `новые или изменённые тесты (${f.tests.map((t) => `\`${t}\``).join(", ")}) проходят и на коде до этого хода: изменения они не проверяют`;
}
