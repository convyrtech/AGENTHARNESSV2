// Сколько вызовов инструментов не прошли проверку аргументов в сессиях Pi и сколько из них чинит харнесс.
//   node packages/prsloy-harness/scripts/count-tool-errors.mts /home/user/ab/run.rec/state/sessions
// Принимает файлы *.jsonl и папки (ищет *.jsonl внутри). Печатает таблицу по файлам и итог.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { repairToolCall, type ToolCallPart } from "../src/arg-repair.ts";

function files(path: string): string[] {
  if (statSync(path).isDirectory())
    return readdirSync(path).flatMap((name) => files(join(path, name)));
  return path.endsWith(".jsonl") ? [path] : [];
}

interface Message {
  role?: string;
  content?: unknown;
  toolCallId?: string;
  isError?: boolean;
}

const textOf = (m: Message) =>
  Array.isArray(m.content)
    ? (m.content as { type: string; text?: string }[])
        .map((p) => (p.type === "text" ? (p.text ?? "") : ""))
        .join("")
    : typeof m.content === "string"
      ? m.content
      : "";

/** Вызов из текста ошибки: «Received arguments:\n<json>» — то, что прислала модель. */
function callFromError(name: string, text: string): ToolCallPart {
  const at = text.indexOf("Received arguments:\n");
  const raw = at >= 0 ? text.slice(at + "Received arguments:\n".length) : "";
  if (text.startsWith("Invalid arguments")) {
    return {
      type: "toolCall",
      id: "x",
      name,
      arguments: {},
      argumentsError: `x\n\nReceived arguments:\n${raw}`,
    };
  }
  let args: unknown = {};
  try {
    args = JSON.parse(raw);
  } catch {
    args = raw;
  }
  return { type: "toolCall", id: "x", name, arguments: args };
}

const totals = { sessions: 0, calls: 0, validation: 0, parse: 0, repairable: 0 };
const kinds: Record<string, number> = {};
const rows: string[] = [];
for (const arg of process.argv.slice(2)) {
  for (const file of files(arg)) {
    let calls = 0;
    let validation = 0;
    let parse = 0;
    let repairable = 0;
    let messages = 0;
    const names = new Map<string, string>();
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let entry: { type?: string; message?: Message };
      try {
        entry = JSON.parse(line) as typeof entry;
      } catch {
        continue;
      }
      const m = entry.message;
      if (entry.type !== "message" || !m) continue;
      messages += 1;
      if (m.role === "assistant" && Array.isArray(m.content)) {
        for (const p of m.content as { type: string; id?: string; name?: string }[]) {
          if (p.type !== "toolCall") continue;
          calls += 1;
          if (p.id && p.name) names.set(p.id, p.name);
        }
      }
      if (m.role === "toolResult" && m.isError) {
        const text = textOf(m);
        const match = /^(Validation failed|Invalid arguments) for tool "([^"]+)"/.exec(text);
        if (!match) continue;
        if (match[1] === "Validation failed") validation += 1;
        else parse += 1;
        const name = match[2] ?? names.get(m.toolCallId ?? "") ?? "?";
        // Схем инструментов в сессии нет: ремонт без схемы (JSON строкой, обёртка, кавычки, пути Windows).
        const fixed = repairToolCall(callFromError(name, text), undefined, "win32");
        if (fixed && !fixed.call.argumentsError) {
          repairable += 1;
          for (const k of fixed.kinds) kinds[k] = (kinds[k] ?? 0) + 1;
        }
      }
    }
    if (messages === 0) continue; // не сессия (метрики прокси и т. п.)
    totals.sessions += 1;
    totals.calls += calls;
    totals.validation += validation;
    totals.parse += parse;
    totals.repairable += repairable;
    if (validation + parse > 0)
      rows.push(`| ${basename(file)} | ${calls} | ${validation} | ${parse} | ${repairable} |`);
  }
}

console.log("| Сессия | Вызовов | Ошибка схемы | Битый JSON | Чинит харнесс |");
console.log("| --- | --- | --- | --- | --- |");
for (const row of rows) console.log(row);
console.log(
  `\nСессий ${totals.sessions}, вызовов ${totals.calls}; ошибок проверки аргументов ${totals.validation + totals.parse} ` +
    `(схема ${totals.validation}, битый JSON ${totals.parse}); из них чинит харнесс (без схемы) ${totals.repairable}` +
    (Object.keys(kinds).length
      ? `: ${Object.entries(kinds)
          .map(([k, n]) => `${k} ${n}`)
          .join(", ")}`
      : "") +
    ".",
);
