// Память M-3 (research/24 §3.1): приёмка экстрактора в тени. Два режима.
//
// 1) 60 размеченных фраз через живой шлюз тем же кодом, что в приложении (memory-extractor.ts):
//    фраза без сигнала (M-2) в модель не идёт; с сигналом — один вызов, проверки §3.4.
//      PRSLOY_GATEWAY_KEY=… node apps/desktop/scripts/memory-shadow-check.mts --phrases
//      … --model qwen3.8-max   (по умолчанию qwen3.8-max)   … --base-url …   … --out file.json
//
// 2) Отчёт по сессиям владельца — журналы тени из папки агента, без сети и без ключа:
//      node apps/desktop/scripts/memory-shadow-check.mts --agent-dir "%APPDATA%\PRSLOY\agent"
//    Вердикты, цена на сессию и список принятых кандидатов (текст + цитата) для ручной разметки.
//
// Ключ берётся только из окружения; в вывод и файлы не попадает (заменяется на ***).
// Цели приёмки: ≥80% принятых кандидатов верны (размечает человек), 0 секретов, 0 цитат не из слов
// пользователя — среди принятых их быть не может по построению, отказы видны по вердиктам.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { messageSignals } from "@prsloy/harness";
import { extractOnce } from "../src/main/prsloy/memory-extractor.ts";

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

function readLines(path: string): Record<string, unknown>[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

const count = (values: unknown[]) => {
  const out: Record<string, number> = {};
  for (const v of values) out[String(v)] = (out[String(v)] ?? 0) + 1;
  return out;
};

async function phrases(): Promise<number> {
  const key = process.env.PRSLOY_GATEWAY_KEY?.trim();
  if (!key) {
    console.error("Нужен PRSLOY_GATEWAY_KEY в окружении.");
    return 2;
  }
  const baseUrl =
    option("--base-url") ?? process.env.PRSLOY_BASE_URL ?? "https://api.prsloy.online/v1";
  const model = option("--model") ?? "qwen3.8-max";
  const fixture = JSON.parse(
    readFileSync(
      resolve(
        import.meta.dirname,
        "../../../packages/prsloy-harness/test/fixtures/memory-signals.json",
      ),
      "utf8",
    ),
  ) as { phrases: { text: string; signal: boolean }[] };
  const rows: Record<string, unknown>[] = [];
  let cost = 0;
  let calls = 0;
  for (const [i, p] of fixture.phrases.entries()) {
    const kinds = messageSignals(p.text);
    if (!kinds.length) {
      rows.push({ text: p.text, label: p.signal, called: false, accepted: [] });
      continue;
    }
    const { call, ops, candidates } = await extractOnce({
      baseUrl,
      apiKey: key,
      model,
      messages: [{ id: `p${i}`, text: p.text, kinds }],
      memory: { user: [], project: [] },
      fetch,
    });
    calls += 1;
    cost += call.costUsd ?? 0;
    rows.push({
      text: p.text,
      label: p.signal,
      called: true,
      json: ops !== undefined,
      error: call.error,
      verdicts: candidates.map((c) => c.verdict),
      accepted: candidates.filter((c) => c.verdict === "ok").map((c) => c.text),
    });
    console.error(`${i + 1}/${fixture.phrases.length} ${call.error ? "ошибка" : "ok"}`);
  }
  const accepted = (r: Record<string, unknown>) => (r.accepted as string[]).length > 0;
  const positives = rows.filter((r) => r.label);
  const negatives = rows.filter((r) => !r.label);
  const report = {
    model,
    calls,
    costUsd: Number(cost.toFixed(6)),
    caught: `${positives.filter(accepted).length}/${positives.length}`,
    falseAccepted: `${negatives.filter(accepted).length}/${negatives.length}`,
    notJson: rows.filter((r) => r.called && !r.json).length,
    verdicts: count(rows.flatMap((r) => (r.verdicts as string[] | undefined) ?? [])),
    rows,
  };
  const out = resolve(
    option("--out") ?? `memory-shadow-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`,
  );
  writeFileSync(out, `${JSON.stringify(report, null, 2).split(key).join("***")}\n`);
  console.log(
    [
      `Модель: ${model}; вызовов ${calls}; цена $${report.costUsd}`,
      `Пойманные (есть принятый кандидат): ${report.caught}`,
      `Ложные (принят кандидат на разовой фразе): ${report.falseAccepted}`,
      `Ответ не JSON: ${report.notJson}`,
      `Вердикты: ${JSON.stringify(report.verdicts)}`,
      `JSON: ${out}`,
    ].join("\n"),
  );
  return 0;
}

function sessions(agentDir: string): number {
  const dir = join(agentDir, "prsloy-memory");
  const runs = readLines(join(dir, "extractor.jsonl")).filter((r) => r.kind === "extract");
  const candidates = readLines(join(dir, "candidates.jsonl"));
  const called = runs.filter((r) => !r.skipped);
  const costs = called.map((r) => r.costUsd).filter((c): c is number => typeof c === "number");
  const accepted = candidates.filter((c) => c.verdict === "ok");
  console.log(
    [
      `Сессий просмотрено: ${new Set(runs.map((r) => r.session)).size}; вызовов модели: ${called.length}; без сигнала: ${runs.length - called.length}`,
      `Цена: всего $${costs.reduce((a, b) => a + b, 0).toFixed(6)}; на вызов $${costs.length ? (costs.reduce((a, b) => a + b, 0) / costs.length).toFixed(6) : "—"}; без цены ${called.length - costs.length}`,
      `Ответ не JSON: ${called.filter((r) => r.json === false).length}; ошибки: ${called.filter((r) => r.ok === false).length}`,
      `Кандидаты: ${candidates.length}; вердикты ${JSON.stringify(count(candidates.map((c) => c.verdict)))}`,
      "",
      "Принятые — разметьте верно / неверно:",
      ...accepted.map(
        (c, i) =>
          `${i + 1}. [${String(c.scope)}/${String(c.kind)}] ${String(c.text)}  ← «${String(c.quote)}»`,
      ),
    ].join("\n"),
  );
  return 0;
}

const agentDir = option("--agent-dir");
const code = args.includes("--phrases")
  ? await phrases()
  : agentDir
    ? sessions(agentDir)
    : (console.error("Нужен --phrases или --agent-dir <папка агента>."), 2);
process.exit(code);
