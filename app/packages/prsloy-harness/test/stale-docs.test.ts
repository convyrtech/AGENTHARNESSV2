// Устаревшее описание проекта (#6 потока): варианты за флагом "staleDocs". "prompt" ничего не добавляет; "end" —
// раздел после AGENTS.md; "frame" — пометка в начале AGENTS.md; "read" — строка в результате read файла описания;
// "gate" — один возврат, когда в ходе с правками об описании ни слова. Без файла описания — ничего.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { readFlags, type StaleDocsMode } from "../src/flags.ts";
import { resolveOptions } from "../src/options.ts";
import {
  DOC_FILE,
  DOCS_MENTIONED,
  installStaleDocs,
  STALE_DOCS_END_SECTION,
  STALE_DOCS_FRAME,
  STALE_DOCS_NUDGE,
  STALE_DOCS_READ_NOTE,
} from "../src/stale-docs.ts";
import { MockPi } from "./mock-pi.ts";

const root = mkdtempSync(join(tmpdir(), "prsloy-stale-docs-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

const AGENTS = "# Отчёт\n\n- Вывод — через `print()`.";

function setup(mode: StaleDocsMode | undefined, before?: (pi: MockPi) => void) {
  const settingsPath = join(root, `s${n++}.json`);
  writeFileSync(settingsPath, JSON.stringify(mode ? { staleDocs: mode } : {}));
  const pi = new MockPi(root);
  before?.(pi);
  installStaleDocs(pi.api, resolveOptions({ profile: "code", settingsPath }));
  return pi;
}

async function start(pi: MockPi, docs = true) {
  const o = {
    sections: {} as Record<string, string>,
    contextFiles: docs ? [{ path: join(root, "AGENTS.md"), content: AGENTS }] : [],
  };
  await pi.emit("before_agent_start", {
    messageType: "user",
    prompt: "Добавь итог",
    systemPrompt: "",
    systemPromptOptions: o,
  });
  return o;
}

async function editedTurn(pi: MockPi, answer: string) {
  await pi.call("edit", { path: "report.py", edits: [] }, "ok");
  await pi.assistantMessage({ content: [{ type: "text", text: answer }] });
  return pi.boundary("agent_before_settle", { outcome: "completed" });
}

describe("staleDocs flag", () => {
  it("defaults to «prompt»; known values pass, unknown stay default", () => {
    const p = join(root, "flags.json");
    writeFileSync(p, "{}");
    expect(readFlags(p).staleDocs).toBe("prompt");
    for (const m of ["end", "frame", "read", "gate"] as const) {
      writeFileSync(p, JSON.stringify({ staleDocs: m }));
      expect(readFlags(p).staleDocs).toBe(m);
    }
    writeFileSync(p, JSON.stringify({ staleDocs: "loud" }));
    expect(readFlags(p).staleDocs).toBe("prompt");
  });

  it("doc files: AGENTS.md, CLAUDE.md, README*; not code or other notes", () => {
    for (const f of [
      "AGENTS.md",
      "agents.md",
      "AGENTS.override.md",
      "CLAUDE.md",
      "README",
      "README.md",
      "readme.txt",
    ])
      expect(DOC_FILE.test(f), f).toBe(true);
    for (const f of ["report.py", "NOTES.md", "README-old.md", "AGENTS.md.bak"])
      expect(DOC_FILE.test(f), f).toBe(false);
  });

  it("an answer that speaks of the description counts; a plain «done» does not", () => {
    for (const a of [
      "В описании проекта написано print, а в коде logging — я сделал как в коде.",
      "AGENTS.md устарел: там print, в коде logging.",
      "Описание проекта с кодом сходится.",
    ])
      expect(DOCS_MENTIONED.test(a), a).toBe(true);
    expect(DOCS_MENTIONED.test("Добавил строку «Итого» — 3480 ₽.")).toBe(false);
  });
});

describe("variants", () => {
  it("prompt: nothing added anywhere", async () => {
    const pi = setup(undefined);
    const o = await start(pi);
    expect(o.sections).toEqual({});
    expect(o.contextFiles[0]!.content).toBe(AGENTS);
    const read = await pi.call("read", { path: "AGENTS.md" }, AGENTS);
    expect(read.result!.modified).toBe(false);
    expect((await editedTurn(pi, "Готово.")).continue).toBe(false);
  });

  it("end: a section after project_context, only when there is a description", async () => {
    const pi = setup("end");
    expect((await start(pi)).sections).toEqual({ prsloy_project_notes: STALE_DOCS_END_SECTION });
    expect((await start(pi, false)).sections).toEqual({});
  });

  it("frame: the note heads each description file, once", async () => {
    const pi = setup("frame");
    const o = await start(pi);
    expect(o.contextFiles[0]!.content).toBe(`${STALE_DOCS_FRAME}\n\n${AGENTS}`);
    // Тот же объект на следующем вызове модели — пометка не удваивается.
    await pi.emit("before_agent_start", { messageType: "custom", systemPromptOptions: o });
    expect(o.contextFiles[0]!.content).toBe(`${STALE_DOCS_FRAME}\n\n${AGENTS}`);
  });

  it("read: the note follows a read of AGENTS.md or README, not of code", async () => {
    const pi = setup("read");
    await start(pi);
    const doc = await pi.call("read", { path: "docs/../README.md" }, "# readme");
    expect(doc.result!.text).toBe(`# readme\n\n${STALE_DOCS_READ_NOTE}`);
    const code = await pi.call("read", { path: "report.py" }, "print(1)");
    expect(code.result!.modified).toBe(false);
  });

  it("gate: one nudge when the turn edited and the answer is silent about the description", async () => {
    const pi = setup("gate");
    await start(pi);
    const first = await editedTurn(pi, "Добавил строку «Итого» — 3480 ₽.");
    expect(first.continue).toBe(true);
    expect(first.entries).toEqual([
      expect.objectContaining({
        customType: "prsloy-harness.stale-docs",
        content: STALE_DOCS_NUDGE,
      }),
    ]);
    // Раз за сообщение пользователя.
    expect((await editedTurn(pi, "Готово.")).continue).toBe(false);
  });

  it("gate: silent when the answer names it, nothing was edited, no description, or another check continues", async () => {
    let pi = setup("gate");
    await start(pi);
    expect(
      (
        await editedTurn(
          pi,
          "В описании проекта написано print, а в коде logging — сделал как в коде.",
        )
      ).continue,
    ).toBe(false);

    pi = setup("gate");
    await start(pi);
    await pi.assistantMessage({ content: [{ type: "text", text: "Готово." }] });
    expect((await pi.boundary("agent_before_settle", { outcome: "completed" })).continue).toBe(
      false,
    );

    pi = setup("gate");
    await start(pi, false);
    expect((await editedTurn(pi, "Готово.")).continue).toBe(false);

    // Гейт уже вернул модель к работе — сначала пусть доделает.
    pi = setup("gate", (p) =>
      p.api.on("agent_before_settle", (e) => ({ entries: e.entries, continue: true })),
    );
    await start(pi);
    const res = await editedTurn(pi, "Готово.");
    expect([res.continue, res.entries]).toEqual([true, []]);
  });

  it("gate: a README read during the turn counts as a description", async () => {
    const pi = setup("gate");
    await start(pi, false);
    await pi.call("read", { path: "README.md" }, "# readme");
    expect((await editedTurn(pi, "Готово.")).continue).toBe(true);
  });
});
