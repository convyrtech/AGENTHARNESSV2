#!/usr/bin/env node
/**
 * The novice's first hour, every night (research/28 §5): the scripted journeys of
 * e2e/features-first-hour.spec.ts (all goes well) and e2e/features-first-hour-bad.spec.ts (the balance, the
 * internet, a slow model, a taken port, a crash, npm offline) on the fake gateway (no key, no tokens), their screenshots and a short
 * «что видит новичок» list — NOVICE.md — in one folder for the run's artifact. A regression in the first
 * hour shows up there without anyone asking.
 *
 *   xvfb-run -a node scripts/first-hour-nightly.mjs --out first-hour-out [--no-build]
 *
 * The exit code is the journeys' (red when one broke), after the report is written either way.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const out = resolve(value("--out", "first-hour-out"));

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

if (!flag("--no-build")) {
  const build = spawnSync("pnpm", ["run", "build"], { cwd: APP, stdio: "inherit" });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const results = join(out, "results.json");
const run = spawnSync(
  "npx",
  [
    "playwright",
    "test",
    "e2e/features-first-hour.spec.ts",
    "e2e/features-first-hour-bad.spec.ts",
    "--reporter=list,json",
  ],
  {
    cwd: APP,
    stdio: "inherit",
    env: { ...process.env, FIRST_HOUR_OUT: out, PLAYWRIGHT_JSON_OUTPUT_NAME: results },
  },
);

writeFileSync(
  join(out, "NOVICE.md"),
  novice(readResults(results), readSeen(join(out, "seen.jsonl"))),
);
console.log(`first hour: ${join(out, "NOVICE.md")}`);
process.exit(run.status ?? 1);

/** Playwright's JSON report → [{ title, status, error }]. */
function readResults(path) {
  if (!existsSync(path)) return [];
  const report = JSON.parse(readFileSync(path, "utf8"));
  const tests = [];
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const last = t.results?.at(-1);
        const error = last?.error?.message ?? "";
        tests.push({
          title: spec.title,
          status: last?.status ?? t.status ?? "unknown",
          error: error
            .replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "gu"), "")
            .split("\n")
            .filter(Boolean)
            .slice(0, 3)
            .join(" · "),
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites ?? []) walk(suite);
  return tests;
}

function readSeen(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** «Что видит новичок»: per journey — passed or not, and at each screenshot the cards, a dialog, the reply. */
export function novice(tests, seen) {
  const passed = tests.filter((t) => t.status === "passed").length;
  const lines = [
    "# Первый час новичка",
    "",
    `Проходов: ${tests.length}, прошло: ${passed}. Фейковый шлюз по сценарию, без ключа.`,
    "",
  ];
  for (const t of tests) {
    lines.push(`## ${t.status === "passed" ? "✓" : "✗"} ${t.title}`, "");
    if (t.status !== "passed") lines.push(`**Сломалось:** ${t.error || t.status}`, "");
    for (const s of seen.filter((x) => x.test === t.title)) {
      lines.push(`- **${s.shot}** (screens/${s.shot}.png)`);
      if (s.dialog) lines.push(`  - окно: ${clip(s.dialog)}`);
      for (const card of s.cards ?? []) lines.push(`  - карточка: ${clip(card)}`);
      if (s.reply) lines.push(`  - ответ: ${clip(s.reply)}`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function clip(text) {
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}
