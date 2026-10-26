// Перезапускает ли агент работу после сжатия контекста — счёт по сессиям Pi.
//   node --experimental-strip-types --no-warnings packages/prsloy-harness/scripts/compaction-stats.mts <папка-или-файл>... [--json]
// Ищет *.jsonl рекурсивно (кроме prsloy-proxy.jsonl). Печатает таблицу по файлам и итог, с --json — JSON.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { parseArgs } from "node:util";
import { compactionStats, type CompactionStats } from "../bench/lib/compaction-stats.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { json: { type: "boolean", default: false } },
});

if (positionals.length === 0) {
  console.error("usage: compaction-stats.mts <dir-or-file>... [--json]");
  process.exit(2);
}

function files(path: string): string[] {
  if (statSync(path).isDirectory())
    return readdirSync(path)
      .sort()
      .flatMap((name) => files(join(path, name)));
  return path.endsWith(".jsonl") && basename(path) !== "prsloy-proxy.jsonl" ? [path] : [];
}

function entriesOf(file: string): unknown[] {
  const out: unknown[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // битая строка — пропускаем
    }
  }
  return out;
}

const sessions: ({ file: string } & CompactionStats)[] = [];
for (const arg of positionals) {
  const root = statSync(arg).isDirectory() ? arg : join(arg, "..");
  for (const file of files(arg)) {
    sessions.push({ file: relative(root, file), ...compactionStats(entriesOf(file)) });
  }
}

const sum = (k: keyof CompactionStats) =>
  sessions.reduce((n, s) => n + (typeof s[k] === "boolean" ? (s[k] ? 1 : 0) : (s[k] as number)), 0);
const totals = {
  sessions: sessions.length,
  withCompaction: sessions.filter((s) => s.compactions > 0).length,
  compactions: sum("compactions"),
  callsBefore: sum("callsBefore"),
  callsAfter: sum("callsAfter"),
  rereadAfter: sum("rereadAfter"),
  rerunAfter: sum("rerunAfter"),
  docsAfter: sum("docsAfter"),
  thread: sum("thread"),
};

if (values.json) {
  console.log(JSON.stringify({ sessions, totals }, null, 2));
} else {
  const cols: (keyof CompactionStats)[] = [
    "compactions",
    "callsBefore",
    "callsAfter",
    "rereadAfter",
    "rerunAfter",
    "docsAfter",
    "thread",
  ];
  console.log(`| file | ${cols.join(" | ")} |`);
  console.log(`|---|${cols.map(() => "---:").join("|")}|`);
  for (const s of sessions)
    console.log(`| ${s.file} | ${cols.map((c) => String(s[c])).join(" | ")} |`);
  console.log(
    `| **total** (${totals.sessions} sessions, ${totals.withCompaction} with ≥1 compaction) | ${cols.map((c) => totals[c]).join(" | ")} |`,
  );
}
