// Сколько вызовов инструментов пришли с «[OI]» вместо «OpenAI» в аргументах (подмена у канала kimi), по моделям.
//   node packages/prsloy-harness/scripts/count-oi.mts bench-out [ещё папки или файлы *.jsonl]
// Читает сессии Pi (prsloy-proxy.jsonl — только метрики, его пропускает). Харнесс чинит это у kimi в arg-repair.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { PROVIDER_OI } from "../src/arg-repair.ts";

function files(path: string): string[] {
  if (statSync(path).isDirectory())
    return readdirSync(path).flatMap((name) => files(join(path, name)));
  return path.endsWith(".jsonl") && basename(path) !== "prsloy-proxy.jsonl" ? [path] : [];
}

interface Row {
  calls: number;
  oi: number;
  sessions: Set<string>;
}

const byModel = new Map<string, Row>();
for (const file of process.argv.slice(2).flatMap(files))
  for (const line of readFileSync(file, "utf8").split("\n")) {
    let entry: { message?: { role?: string; model?: string; content?: unknown } };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    const m = entry.message;
    if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
    const model = m.model ?? "?";
    const row = byModel.get(model) ?? { calls: 0, oi: 0, sessions: new Set<string>() };
    byModel.set(model, row);
    for (const part of m.content as { type?: string; arguments?: unknown }[]) {
      if (part.type !== "toolCall") continue;
      row.calls += 1;
      if (JSON.stringify(part.arguments ?? "").includes(PROVIDER_OI)) {
        row.oi += 1;
        row.sessions.add(file);
      }
    }
  }
for (const [model, r] of [...byModel].sort((a, b) => b[1].oi - a[1].oi))
  console.log(
    `${model}: вызовов ${r.calls}, с «${PROVIDER_OI}» ${r.oi}, сессий ${r.sessions.size}`,
  );
