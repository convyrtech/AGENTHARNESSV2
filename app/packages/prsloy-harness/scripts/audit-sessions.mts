// Разборщик сессий, A-0 (research/24 §6): детекторы-код по сессиям Pi, 0 токенов, без сети.
//   node packages/prsloy-harness/scripts/audit-sessions.mts --sessions /home/user/bench --out audit-out
//   … --sessions <папка или файл> (можно несколько)   рекурсивно *.jsonl; turns.jsonl рядом → «Дизайн»
//   … --bench <bench-*.json> (можно несколько)        исход check.mjs по сессии (для D2)
//   … --rules audit/rules.json                         правила D11 (по умолчанию — рядом с пакетом)
//   … --out audit-out                                  findings.jsonl (с цитатами — не в git!),
//                                                       audit-events.jsonl (без текста), REPORT-audit.md
//   … --dry-run                                        то же самое: модели в A-0 нет вообще; флаг для единообразия
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import rulesFile from "../audit/rules.json" with { type: "json" };
import {
  auditReport,
  auditSessions,
  toAuditEvent,
  type Finding,
  type Rule,
} from "../src/audit/detectors.ts";
import { loadSessions, type Session, type Surface } from "../src/audit/ir.ts";

const { values } = parseArgs({
  options: {
    sessions: { type: "string", multiple: true, default: [] },
    bench: { type: "string", multiple: true, default: [] },
    rules: { type: "string" },
    surface: { type: "string" },
    out: { type: "string", default: "audit-out" },
    "dry-run": { type: "boolean", default: false },
  },
});

if (values.sessions.length === 0) {
  console.error(
    "usage: audit-sessions.mts --sessions <dir> [--bench bench-*.json] [--out audit-out]",
  );
  process.exit(2);
}

const started = performance.now();
const rules = (
  values.rules ? (JSON.parse(readFileSync(values.rules, "utf8")) as typeof rulesFile) : rulesFile
).rules as Rule[];
const surface = values.surface as Surface | undefined;
const sessions: Session[] = values.sessions.flatMap((dir) =>
  loadSessions(dir, surface ? { surface } : {}),
);

// bench-*.json: { results: [{ task, model, ok, session? }] } — исход check.mjs для D2.
for (const file of values.bench) {
  const data = JSON.parse(readFileSync(file, "utf8")) as {
    results?: { task?: string; ok?: boolean; session?: string; sessionFile?: string }[];
  };
  for (const r of data.results ?? []) {
    const ref = r.session ?? r.sessionFile;
    const s = sessions.find(
      (x) =>
        (ref && (x.id === ref || x.file.endsWith(ref))) || (!ref && r.task && x.task === r.task),
    );
    if (s && typeof r.ok === "boolean") {
      s.benchOk = r.ok;
      if (r.task) s.task = r.task;
    }
  }
}

const findings: Finding[] = auditSessions(sessions, { rules });
const seconds = (performance.now() - started) / 1000;
const now = new Date();
const stamp = now.toISOString().slice(0, 10).replace(/-/g, "");
findings.forEach((f, i) =>
  Object.assign(f, { id: `F-${stamp}-${String(i + 1).padStart(4, "0")}` }),
);

mkdirSync(values.out, { recursive: true });
writeFileSync(
  join(values.out, "findings.jsonl"),
  findings.map((f) => JSON.stringify(f)).join("\n") + (findings.length ? "\n" : ""),
);
writeFileSync(
  join(values.out, "audit-events.jsonl"),
  findings.map((f) => JSON.stringify(toAuditEvent(f, now.toISOString()))).join("\n") +
    (findings.length ? "\n" : ""),
);
const report = auditReport(
  sessions,
  findings,
  now.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" }),
  seconds,
);
writeFileSync(join(values.out, "REPORT-audit.md"), report);
console.log(report);
console.log(
  `${sessions.length} сессий, ${sessions.reduce((n, s) => n + s.steps.length, 0)} шагов, ${findings.length} находок за ${seconds.toFixed(1)} с → ${values.out}/`,
);
