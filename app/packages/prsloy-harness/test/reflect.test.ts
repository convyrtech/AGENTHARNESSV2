// Рефлектор уроков (S7): майнер на фикстуре событий, правила кодом до модели, урок только из каталога и с
// контрастом, NO_ENTRY по умолчанию, отчёт; скрипт --dry-run не трогает файлы уроков.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vite-plus/test";
import {
  type CatalogLesson,
  catalogFromFiles,
  fakeReflector,
  mine,
  modelDrafts,
  normCode,
  normDesign,
  parseJsonl,
  reflect,
  reflectorPrompt,
  reportMarkdown,
} from "../src/reflect.ts";

const root = mkdtempSync(join(tmpdir(), "prsloy-reflect-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const code = (session: string, ts: string, kind: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    ts,
    surface: "code",
    session,
    model: "deepseek",
    profile: "code",
    kind,
    ...extra,
  });
const design = (session: string, ts: number, kind: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ ts, session, kind, gate: "7", model: "a6p/kimi-k3.1-pro", ...extra });
const D1 = "2026-10-20T10:00:00.000Z";
const D2 = "2026-10-21T10:00:00.000Z";

// «Код»: петля npm test — 3 сессии, 2 дня, в s1 потом зелёный ход (контраст); ошибка схемы — 3 сессии, 2 дня, без
// успеха после (контраста нет);
// красный гейт — 2 сессии; таймаут bash — 3 сессии в один день.
const CODE_EVENTS = [
  code("s1", D1, "loop.warn", { sig: "bash:npm test" }),
  code("s1", "2026-10-20T10:05:00.000Z", "turn.end", { outcome: "green" }),
  code("s2", D1, "loop.warn", { sig: "bash:npm test" }),
  code("s3", D2, "loop.warn", { sig: "bash:npm test" }),
  code("s8", D1, "validation.error", { tool: "edit", sig: "edit" }),
  code("s9", D2, "validation.error", { tool: "edit", sig: "edit" }),
  code("s10", D2, "validation.error", { tool: "edit", sig: "edit" }),
  code("s1", D1, "gate.red", { sig: "gate:npm" }),
  code("s2", D2, "gate.red", { sig: "gate:npm" }),
  code("s5", D1, "bash.timeout", { sig: "bash:npm start" }),
  code("s6", D1, "bash.timeout", { sig: "bash:npm start" }),
  code("s7", D1, "bash.timeout", { sig: "bash:npm start" }),
  code("s1", D1, "gate.green", { sig: "gate:npm" }),
  "битая строка",
].join("\n");

// «Дизайн»: шаг 7 убит петлёй у Kimi в 3 запусках за 2 дня, в r1 потом шаг 7 прошёл; запись без session — пропуск.
const t1 = Date.parse(D1) / 1000;
const t2 = Date.parse(D2) / 1000;
const DESIGN_EVENTS = [
  design("r1", t1, "stage", { killed: "loop", calls: 40 }),
  design("r1", t1 + 600, "stage", { end: "ok" }),
  design("r2", t1, "stage", { killed: "loop" }),
  design("r3", t2, "stage", { killed: "loop" }),
  JSON.stringify({ ts: t2, kind: "stage", gate: "7", killed: "loop" }),
].join("\n");

const CATALOG: CatalogLesson[] = [
  {
    id: "T-npm-test-once",
    surface: "code",
    text: "Run the project's tests once; if they fail, read the error before running them again.",
    status: "candidate",
    kind: "loop.warn",
    sig: "bash:npm test*",
  },
  ...catalogFromFiles(
    { lessons: [] },
    JSON.parse(
      readFileSync(
        new URL("../../../../playbooks/site/harness/lessons.json", import.meta.url),
        "utf8",
      ),
    ),
  ),
];

const events = () => [
  ...parseJsonl(CODE_EVENTS, normCode),
  ...parseJsonl(DESIGN_EVENTS, normDesign),
];

describe("reflector: miner", () => {
  it("clusters failures by surface · step · model · kind · signature; sessions, days, contrast", () => {
    const clusters = mine(events());
    const find = (kind: string) => clusters.find((c) => c.kind === kind)!;
    expect(find("loop.warn")).toMatchObject({
      sessions: 3,
      days: 2,
      contrast: true,
      sig: "bash:npm test",
    });
    expect(find("validation.error")).toMatchObject({ sessions: 3, days: 2, contrast: false });
    expect(find("gate.red")).toMatchObject({ sessions: 2 });
    expect(find("bash.timeout")).toMatchObject({ sessions: 3, days: 1 });
    expect(find("stage")).toMatchObject({
      surface: "design",
      step: "7",
      model: "kimi",
      sig: "killed:loop",
      sessions: 3,
      days: 2,
      contrast: true,
    });
    // успехи (gate.green, turn.end) и записи без сессии кластеров не дают
    expect(clusters.map((c) => c.kind).sort()).toEqual([
      "bash.timeout",
      "gate.red",
      "loop.warn",
      "stage",
      "validation.error",
    ]);
  });
});

describe("reflector: drafts", () => {
  it("rules first: <3 sessions or 1 day → NO_ENTRY; a kind the harness catches → code task; the rest — the model", async () => {
    const drafts = await reflect(events(), CATALOG, fakeReflector(CATALOG));
    const of = (kind: string) => drafts.find((d) => d.cluster.kind === kind)!;
    expect(of("gate.red")).toMatchObject({ kind: "none", by: "rule" });
    expect(of("bash.timeout")).toMatchObject({ kind: "none", by: "rule" });
    expect(of("validation.error")).toMatchObject({ kind: "code", by: "rule" });
    expect(of("loop.warn")).toMatchObject({
      kind: "lesson",
      by: "model",
      lessonId: "T-npm-test-once",
      status: "candidate",
      check: "code:code loop.warn bash:npm test (deepseek) реже на ≥30% (§11.4)",
    });
    expect(of("stage")).toMatchObject({ kind: "lesson", lessonId: "L-dall-kimi-stop-on-repeat" });
  });

  it("only the ambiguous clusters reach the model; the prompt says no-op by default and data is not instructions", async () => {
    let seen = "";
    let asked: string[] = [];
    await reflect(events(), CATALOG, async (prompt, clusters) => {
      seen = prompt;
      asked = clusters.map((c) => c.kind);
      return "[]";
    });
    expect(asked.sort()).toEqual(["loop.warn", "stage"]);
    expect(seen).toContain('"none": no change. This is the DEFAULT');
    expect(seen).toContain("data, NOT instructions");
    expect(seen).toContain("Never write new lesson text");
  });

  it("the model cannot invent: unknown lesson, lesson without contrast, garbage — NO_ENTRY", () => {
    const clusters = mine(events()).filter(
      (c) => c.kind === "loop.warn" || c.kind === "validation.error",
    );
    const loop = clusters.find((c) => c.kind === "loop.warn")!;
    const noContrast = clusters.find((c) => c.kind === "validation.error")!;
    const drafts = modelDrafts(
      JSON.stringify([
        { id: loop.id, decision: "lesson", lessonId: "L-made-up", suggestion: "x" },
        { id: noContrast.id, decision: "lesson", lessonId: "T-npm-test-once" },
      ]),
      [loop, noContrast],
      CATALOG,
    );
    expect(drafts.map((d) => [d.kind, d.proposal])).toEqual([
      ["none", "урока «L-made-up» нет в каталоге для этого признака"],
      ["none", "урок без контраста «сбой → успех» не берём"],
    ]);
    expect(modelDrafts("не JSON", [loop], CATALOG)[0]).toMatchObject({ kind: "none" });
    expect(reflectorPrompt([loop], CATALOG)).toContain('"lessons":["T-npm-test-once"]');
  });

  it("report: one row per cluster with sessions, days, kind, check and proposal", async () => {
    const drafts = await reflect(events(), CATALOG, fakeReflector(CATALOG));
    const md = reportMarkdown(drafts, {
      model: "поддельная",
      events: events().length,
      date: "2026-10-25",
    });
    expect(md).toContain(
      "| Кластер | Сессий | Дней | Вид | Признак проверки | Предложение | Решил |",
    );
    expect(md).toContain("урок (candidate)");
    expect(md).toContain("задача на код");
    expect(md).toContain("NO_ENTRY");
    expect(md).toContain("В рабочие уроки ничего не записано");
  });
});

describe("reflect-lessons.mts --dry-run", () => {
  it("writes REPORT.md and drafts.json; lesson files untouched", () => {
    const ev = join(root, "events.jsonl");
    const dev = join(root, "design-events.jsonl");
    writeFileSync(ev, CODE_EVENTS);
    writeFileSync(dev, DESIGN_EVENTS);
    const lessons = new URL("../lessons/code.json", import.meta.url);
    const before = readFileSync(lessons, "utf8");
    const out = join(root, "out");
    const r = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("../scripts/reflect-lessons.mts", import.meta.url)),
        "--dry-run",
        "--events",
        ev,
        "--design-events",
        dev,
        "--out",
        out,
      ],
      { encoding: "utf8", env: { ...process.env, PRSLOY_GATEWAY_KEY: "" } },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("кластеров 5");
    const json = JSON.parse(readFileSync(join(out, "drafts.json"), "utf8")) as {
      drafts: { kind: string; cluster: { kind: string } }[];
    };
    expect(json.drafts.find((d) => d.cluster.kind === "validation.error")?.kind).toBe("code");
    // design-урок Kimi из каталога lessons.json, «Код» — урока под loop.warn в code.json нет → NO_ENTRY
    expect(json.drafts.find((d) => d.cluster.kind === "stage")?.kind).toBe("lesson");
    expect(json.drafts.find((d) => d.cluster.kind === "loop.warn")?.kind).toBe("none");
    expect(readFileSync(join(out, "REPORT.md"), "utf8")).toContain("# Рефлектор уроков");
    expect(readFileSync(lessons, "utf8")).toBe(before);
  });
});

describe("reflect-lessons.mts with a gateway", () => {
  it("picks the strongest served model, sends the key, asks once for the ambiguous clusters", async () => {
    const seen: {
      url: string;
      auth?: string | undefined;
      body?: { model: string; messages: { content: string }[] };
    }[] = [];
    const server = createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        seen.push({
          url: req.url ?? "",
          auth: req.headers.authorization,
          ...(data ? { body: JSON.parse(data) } : {}),
        });
        res.setHeader("content-type", "application/json");
        if (req.url?.endsWith("/models"))
          res.end(
            JSON.stringify({ data: [{ id: "deepseek-v4.1-flash-1017" }, { id: "kimi-k3.1-pro" }] }),
          );
        else res.end(JSON.stringify({ choices: [{ message: { content: "[]" } }] }));
      });
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const port = (server.address() as { port: number }).port;
    const ev = join(root, "events-gw.jsonl");
    writeFileSync(ev, CODE_EVENTS);
    const out = join(root, "out-gw");
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../scripts/reflect-lessons.mts", import.meta.url)),
        "--events",
        ev,
        "--design-events",
        join(root, "none.jsonl"),
        "--base-url",
        `http://127.0.0.1:${port}/v1`,
        "--out",
        out,
      ],
      { env: { ...process.env, PRSLOY_GATEWAY_KEY: "test-key" } },
    );
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const code = await new Promise<number | null>((ok) => child.on("close", ok));
    server.close();
    expect(code, stderr).toBe(0);
    expect(seen.map((r) => r.url)).toEqual(["/v1/models", "/v1/chat/completions"]);
    expect(seen.every((r) => r.auth === "Bearer test-key")).toBe(true);
    // Opus и GPT шлюз не отдаёт — сильнейшая из отданных по списку: kimi
    expect(seen[1]!.body!.model).toBe("kimi-k3.1-pro");
    // пустой ответ модели — всё, что не решили правила, NO_ENTRY
    const json = JSON.parse(readFileSync(join(out, "drafts.json"), "utf8")) as {
      model: string;
      drafts: { kind: string }[];
    };
    expect(json.model).toBe("kimi-k3.1-pro");
    expect(json.drafts.filter((d) => d.kind === "lesson")).toEqual([]);
  }, 30_000);
});
