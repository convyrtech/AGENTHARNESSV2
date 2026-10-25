/**
 * Merges findings-*.json of layout-lint.spec.ts into layout-report.md (and prints it):
 *   node --experimental-strip-types apps/desktop/e2e-audit/layout-report.ts <out dir> [<out dir>…]
 * --seed-baseline=YYYY-MM-DD also adds every open finding (rule × selector, any screen) to
 * layout-baseline.json with that deadline: a first run's debt, to be paid down to empty.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  excuse,
  expired,
  parseBaseline,
  reportTable,
  RULE_TEXT,
  type BaselineEntry,
  type Finding,
} from "./layout-baseline.ts";

const seed = process.argv.find((a) => a.startsWith("--seed-baseline="))?.split("=")[1];
const dirs = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (dirs.length === 0) throw new Error("usage: layout-report.ts <out dir> [<out dir>…]");
const today = new Date().toISOString().slice(0, 10);
const baselineFile = join(dirname(fileURLToPath(import.meta.url)), "layout-baseline.json");
const baselineJson = JSON.parse(readFileSync(baselineFile, "utf8")) as Record<string, unknown>;
const baseline = parseBaseline(baselineJson);

const findings: Finding[] = [];
const runs: string[] = [];
for (const dir of dirs) {
  for (const name of readdirSync(dir)
    .filter((n) => /^findings-.+\.json$/.test(n))
    .sort()) {
    runs.push(name.replace(/^findings-|\.json$/g, ""));
    findings.push(...(JSON.parse(readFileSync(join(dir, name), "utf8")) as Finding[]));
  }
}
const open = findings.filter((f) => !excuse(f, baseline, today));
const excused = findings.length - open.length;
const byRule = Object.entries(RULE_TEXT)
  .map(([rule, text]) => [text, open.filter((f) => f.rule === rule).length] as const)
  .filter(([, n]) => n > 0)
  .map(([text, n]) => `${text}: ${n}`);
const stale = baseline.filter((e) => expired(e, today));

const report = [
  "# Layout lint",
  "",
  `Прогоны: ${runs.join(", ") || "нет"}.`,
  `Нарушений: **${open.length}**${excused ? ` (ещё ${excused} в baseline)` : ""}${byRule.length ? ` — ${byRule.join("; ")}` : ""}.`,
  ...(stale.length
    ? [
        "",
        `Просроченные исключения baseline: ${stale.map((e) => `${e.rule} \`${e.selector}\` (${e.until})`).join(", ")}.`,
      ]
    : []),
  "",
  open.length ? reportTable(open) : "Нарушений нет.",
].join("\n");
writeFileSync(join(dirs[0]!, "layout-report.md"), `${report}\n`);
console.log(report);

if (seed) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(seed)) throw new Error("--seed-baseline=YYYY-MM-DD");
  const added = new Map<string, BaselineEntry>();
  for (const f of open) {
    added.set(`${f.rule}\u0000${f.selector}`, {
      rule: f.rule,
      selector: f.selector,
      screen: "*",
      reason: `первый прогон (${today}): ${f.screen}, «${f.text}» — ${f.detail}`,
      until: seed,
    });
  }
  baselineJson.exceptions = [...baseline, ...added.values()];
  writeFileSync(baselineFile, `${JSON.stringify(baselineJson, null, 2)}\n`);
  console.error(`layout-baseline.json: +${added.size} exceptions until ${seed}`);
}
