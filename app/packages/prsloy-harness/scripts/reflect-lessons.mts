// Рефлектор уроков (S7, research/18 §7), офлайн. Запускает человек с ключом шлюза; уроки сам не пишет.
//   PRSLOY_GATEWAY_KEY=… node packages/prsloy-harness/scripts/reflect-lessons.mts \
//     --events ~/.pi/agent/prsloy-learning/events.jsonl --design-events <HARNESS_LEARN_DIR>/design-events.jsonl
//   … --model claude-opus-5-5     модель рефлектора (по умолчанию — сильнейшая из каталога шлюза /v1/models)
//   … --dry-run                   без ключа: поддельная модель (тесты, проверка майнера)
//   … --out reflect-out           куда положить REPORT.md и drafts.json
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { PRSLOY_DEFAULT_BASE_URL } from "../../../apps/desktop/src/shared/prsloy-config.ts";
import codeLessons from "../lessons/code.json" with { type: "json" };
import {
  catalogFromFiles,
  fakeReflector,
  normCode,
  normDesign,
  parseJsonl,
  reflect,
  type Reflector,
  reportMarkdown,
} from "../src/reflect.ts";

/** Сильнейшая модель рефлектора: первая из этого списка, которую отдаёт шлюз (research/18: Opus 5.5). */
export const REFLECTOR_PREFERENCE = [
  "claude-opus-5-5",
  "gpt-6.1-sol",
  "kimi-k3.1-pro",
  "qwen3.8-max",
  "deepseek-v4.1-flash-1017",
];

const { values } = parseArgs({
  options: {
    events: { type: "string" },
    "design-events": { type: "string" },
    "design-lessons": { type: "string" },
    model: { type: "string" },
    "base-url": { type: "string" },
    "dry-run": { type: "boolean", default: false },
    out: { type: "string", default: "reflect-out" },
  },
});

const read = (path: string | undefined) =>
  path && existsSync(path) ? readFileSync(path, "utf8") : "";
const defaultEvents = process.env.PI_CODING_AGENT_DIR
  ? join(process.env.PI_CODING_AGENT_DIR, "prsloy-learning", "events.jsonl")
  : undefined;
const events = [
  ...parseJsonl(read(values.events ?? defaultEvents), normCode),
  ...parseJsonl(read(values["design-events"]), normDesign),
];
const designLessonsPath =
  values["design-lessons"] ??
  new URL("../../../../playbooks/site/harness/lessons.json", import.meta.url).pathname;
const catalog = catalogFromFiles(codeLessons, JSON.parse(read(designLessonsPath) || "{}"));

const baseUrl = (values["base-url"] ?? PRSLOY_DEFAULT_BASE_URL).replace(/\/+$/, "");
const key = process.env.PRSLOY_GATEWAY_KEY ?? process.env.PRSLOY_KEY;

async function gatewayModels(): Promise<string[]> {
  const r = await fetch(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error(`/models: ${r.status}`);
  const body = (await r.json()) as { data?: { id?: string }[] };
  return (body.data ?? []).map((m) => String(m.id));
}

function gatewayReflector(model: string): Reflector {
  return async (prompt) => {
    const r = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 8000,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!r.ok) throw new Error(`chat/completions: ${r.status} ${(await r.text()).slice(0, 200)}`);
    const body = (await r.json()) as { choices?: { message?: { content?: string } }[] };
    return body.choices?.[0]?.message?.content ?? "";
  };
}

let model = "поддельная (--dry-run)";
let reflector: Reflector;
if (values["dry-run"]) reflector = fakeReflector(catalog);
else {
  if (!key) {
    console.error("Нужен ключ шлюза в PRSLOY_GATEWAY_KEY (или --dry-run).");
    process.exit(2);
  }
  const served = values.model ? [] : await gatewayModels();
  model =
    values.model ??
    REFLECTOR_PREFERENCE.find((id) => served.includes(id)) ??
    served[0] ??
    REFLECTOR_PREFERENCE[0]!;
  reflector = gatewayReflector(model);
}

const drafts = await reflect(events, catalog, reflector);
const date = new Date().toISOString().slice(0, 10);
mkdirSync(values.out!, { recursive: true });
writeFileSync(
  join(values.out!, "REPORT.md"),
  reportMarkdown(drafts, { model, events: events.length, date }),
);
writeFileSync(
  join(values.out!, "drafts.json"),
  `${JSON.stringify({ date, model, events: events.length, drafts }, null, 2)}\n`,
);
console.log(
  `рефлектор: событий ${events.length}, кластеров ${drafts.length}; ` +
    `код ${drafts.filter((d) => d.kind === "code").length}, ` +
    `уроков ${drafts.filter((d) => d.kind === "lesson").length}, ` +
    `NO_ENTRY ${drafts.filter((d) => d.kind === "none").length} → ${join(values.out!, "REPORT.md")}`,
);
