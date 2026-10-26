// Проверка навыков пакета перед выпуском (CI): NVIDIA SkillSpector в статическом режиме (--no-llm: regex, AST,
// taint, YARA, без модели) по каждой папке skills/<навык> и своя проверка src/skill-threats.ts. Провал — оценка
// SkillSpector выше 50 из 100 или любая своя находка.
//
//   node packages/prsloy-harness/scripts/skill-scan.mts                 # все навыки пакета
//   node packages/prsloy-harness/scripts/skill-scan.mts path/to/skills  # другая папка (предложение тюнера)
//   SKILLSPECTOR=/path/to/skillspector …                                # где лежит сканер (иначе ищется в PATH)
//   … --own-only                                                        # только своя проверка (сканера нет)
//   … --json out.json                                                   # итог в файл
// Сканер ставит CI: `uv tool install --python 3.12 git+https://github.com/NVIDIA/skillspector.git@<коммит>`.
// В приложение он не входит. Выход 0 — всё чисто; 1 — есть риск; 2 — не запустилось.
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { SCORE_LIMIT, skillspectorScan, type SpectorResult } from "../src/skill-scan.ts";
import { threatLine, treeThreats } from "../src/skill-threats.ts";
import { skillFilesFromDir } from "../src/skills.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { "own-only": { type: "boolean" }, json: { type: "string" } },
});
const dir = resolve(
  positionals[0] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "skills"),
);
const bin = process.env.SKILLSPECTOR ?? "skillspector";

interface Row extends SpectorResult {
  skill: string;
  own: string[];
}

function main(): number {
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((n) => statSync(join(dir, n)).isDirectory())
      .sort();
  } catch {
    console.error(`Нет папки навыков: ${dir}`);
    return 2;
  }
  const files = skillFilesFromDir(dir);
  const rows: Row[] = [];
  for (const skill of names) {
    const own = treeThreats(
      Object.fromEntries(Object.entries(files[skill] ?? {}).map(([f, t]) => [`${skill}/${f}`, t])),
    ).map(threatLine);
    const scan = values["own-only"] ? { issues: [] } : skillspectorScan(join(dir, skill), bin);
    rows.push({ skill, own, ...scan });
  }
  const broken = rows.filter((r) => r.error);
  for (const r of rows) {
    const score = r.score === undefined ? "—" : `${r.score}/100`;
    const verdict =
      r.error !== undefined
        ? `сбой: ${r.error}`
        : r.own.length || (r.score ?? 0) > SCORE_LIMIT
          ? "РИСК"
          : "чисто";
    console.log(
      `${r.skill}: SkillSpector ${score}${r.severity ? ` ${r.severity}` : ""} · своя проверка ${r.own.length} · ${verdict}`,
    );
    for (const i of r.issues) console.log(`    ${i}`);
    for (const o of r.own) console.log(`    своя: ${o}`);
  }
  if (values.json) writeFileSync(values.json, `${JSON.stringify(rows, null, 2)}\n`);
  if (broken.length && !values["own-only"]) {
    console.error(
      `\nSkillSpector не отработал на ${broken.length} навыках (${bin}). Поставь его или запусти с --own-only.`,
    );
    return 2;
  }
  const risky = rows.filter((r) => r.own.length || (r.score ?? 0) > SCORE_LIMIT);
  console.log(
    risky.length
      ? `\nРиск: ${risky.map((r) => r.skill).join(", ")}`
      : `\nНавыков: ${rows.length}, все чисто.`,
  );
  return risky.length ? 1 : 0;
}

process.exitCode = main();
