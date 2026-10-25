// M-1 (research/24 §3.2, §3.5, §3.6): схема v2, reinforce, «Было» с opId и «Вернуть» байт-в-байт,
// закрепление, стирание при выключении памяти.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { autoDetails, MEMORY_CARD, updatedDetails } from "../src/memory.ts";
import { EVIDENCE_MAX, HISTORY_DAYS, MemoryStore } from "../src/memory-store.ts";

const root = mkdtempSync(join(tmpdir(), "prsloy-mem-m1-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
function fresh() {
  const dir = join(root, `m${++n}`);
  return { store: new MemoryStore(dir), dir, cwd: join(root, `p${n}`) };
}
const journal = (dir: string) =>
  readFileSync(join(dir, "journal.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
const userFile = (dir: string) => readFileSync(join(dir, "user.json"), "utf8");

describe("M-1 store", () => {
  it("a new entry has the v2 fields; the file is version 2", () => {
    const { store, cwd, dir } = fresh();
    const a = store.add("user", cwd, {
      text: "Любит тёмные сайты",
      quote: "люблю тёмные сайты",
      session: "s1",
    });
    if (!a.ok) throw new Error("not added");
    expect(a.opId).toMatch(/^op-[0-9a-f]{12}$/u);
    expect(a.entry).toMatchObject({
      origin: "user",
      strength: 1,
      evidence: [{ quote: "люблю тёмные сайты", session: "s1" }],
    });
    expect(a.entry.lastSeen).toBe(a.entry.created);
    expect(JSON.parse(userFile(dir)).version).toBe(2);
    expect(journal(dir).at(-1)).toMatchObject({ op: "remember", opId: a.opId });
  });

  it("v1 files are read as they are", () => {
    const { store, cwd, dir } = fresh();
    mkdirSync(dir, { recursive: true });
    const v1 = {
      id: "u-old1",
      text: "Писать проще",
      quote: "пиши проще, без умных слов",
      origin: "user",
      created: "2026-10-01T10:00:00.000Z",
    };
    writeFileSync(
      join(dir, "user.json"),
      JSON.stringify({ version: 1, rules: "m0", entries: [v1], tombstones: [] }),
    );
    expect(store.entries("user", cwd)).toEqual([v1]);
    expect(store.history(cwd)).toEqual([]);
  });

  it("a paraphrase reinforces: strength, lastSeen, at most three quotes", () => {
    const { store, cwd, dir } = fresh();
    store.add("user", cwd, { text: "Любит тёмные сайты", quote: "люблю тёмные сайты" });
    const quotes = ["мне нравятся тёмные сайты", "тёмные сайты люблю", "сайты тёмные, люблю"];
    let last;
    for (const quote of quotes)
      last = store.add("user", cwd, { text: "Нравятся тёмные сайты", quote });
    expect(last).toMatchObject({ ok: false, reason: "duplicate" });
    const [entry] = store.entries("user", cwd);
    expect(entry?.strength).toBe(4);
    expect(entry?.evidence?.map((e) => e.quote)).toEqual(quotes);
    expect(entry?.evidence).toHaveLength(EVIDENCE_MAX);
    expect(journal(dir).filter((j) => j.op === "reinforce")).toHaveLength(3);
  });

  it("supersede goes to «Было»; «Вернуть» puts the old entry back byte for byte, in place", () => {
    const { store, cwd, dir } = fresh();
    store.add("user", cwd, { text: "Зовут Аня", quote: "зови меня Аня" });
    store.add("user", cwd, { text: "Любит тёмные сайты", quote: "люблю тёмные сайты" });
    store.add("user", cwd, { text: "Живёт в Казани", quote: "я живу в Казани" });
    const before = JSON.parse(userFile(dir)).entries;
    const flip = store.add("user", cwd, {
      text: "Не любит тёмные сайты",
      quote: "я больше не люблю тёмные сайты",
    });
    if (!flip.ok) throw new Error("not added");
    expect(flip.replaced?.text).toBe("Любит тёмные сайты");
    const [item] = store.history(cwd);
    expect(item).toMatchObject({
      opId: flip.opId,
      kind: "replaced",
      scope: "user",
      entry: { text: "Любит тёмные сайты" },
      now: { text: "Не любит тёмные сайты" },
    });
    expect(store.revert(flip.opId, cwd)?.text).toBe("Любит тёмные сайты");
    expect(JSON.parse(userFile(dir)).entries).toEqual(before);
    expect(store.history(cwd)).toEqual([]);
    expect(journal(dir).at(-1)).toMatchObject({ op: "revert", revertOf: flip.opId });
    // Unknown or used opId: nothing.
    expect(store.revert(flip.opId, cwd)).toBeUndefined();
    expect(store.revert("op-000000000000", cwd)).toBeUndefined();
  });

  it("forgotten: in «Было» from the journal (the file keeps only hashes), back by opId in place", () => {
    const { store, cwd, dir } = fresh();
    store.add("project", cwd, { text: "Бот на Python", quote: "бот на Python" });
    store.add("project", cwd, { text: "Хостинг в Timeweb", quote: "хостинг в Timeweb" });
    const projectPath = join(dir, "projects");
    const a = store.entries("project", cwd)[0]!;
    store.forget(a.id, cwd);
    const [item] = store.history(cwd);
    expect(item).toMatchObject({ kind: "forgotten", scope: "project", entry: { id: a.id } });
    const raw = readFileSync(
      join(projectPath, readdirSync(projectPath)[0]!, "project.json"),
      "utf8",
    );
    expect(raw).not.toMatch(/Python/u);
    expect(store.revert(item!.opId, cwd)?.id).toBe(a.id);
    expect(store.entries("project", cwd).map((e) => e.text)).toEqual([
      "Бот на Python",
      "Хостинг в Timeweb",
    ]);
    expect(store.history(cwd)).toEqual([]);
  });

  it("«Было» keeps 90 days", () => {
    const { store, cwd, dir } = fresh();
    store.add("user", cwd, { text: "Любит тёмные сайты", quote: "люблю тёмные сайты" });
    store.add("user", cwd, { text: "Не любит тёмные сайты", quote: "не люблю тёмные сайты" });
    const file = JSON.parse(userFile(dir));
    file.history[0].at = new Date(Date.now() - (HISTORY_DAYS + 1) * 86_400_000).toISOString();
    writeFileSync(join(dir, "user.json"), JSON.stringify(file));
    // The next write drops it.
    store.add("user", cwd, { text: "Живёт в Казани", quote: "я живу в Казани" });
    expect(JSON.parse(userFile(dir)).history).toBeUndefined();
  });

  it("pin: marks and unmarks; an automatic entry cannot replace a pinned one", () => {
    const { store, cwd, dir } = fresh();
    const a = store.add("user", cwd, { text: "Любит тёмные сайты", quote: "люблю тёмные сайты" });
    if (!a.ok) throw new Error("not added");
    expect(store.pin(a.entry.id, true, cwd)?.pinned).toBe(true);
    expect(
      store.add("user", cwd, {
        text: "Не любит тёмные сайты",
        quote: "не люблю тёмные сайты",
        origin: "auto",
      }),
    ).toEqual({ ok: false, reason: "pinned" });
    expect(store.pin(a.entry.id, false, cwd)?.pinned).toBeUndefined();
    expect(store.pin("u-none", true, cwd)).toBeUndefined();
    expect(journal(dir).filter((j) => j.op === "pin")).toHaveLength(2);
    // The user's own words do replace it (the card «Обновил» shows it).
    store.pin(a.entry.id, true, cwd);
    const flip = store.add("user", cwd, {
      text: "Не любит тёмные сайты",
      quote: "не люблю тёмные сайты",
    });
    expect(flip.ok).toBe(true);
  });

  it("eraseAll: entries, history, digests and journal texts in every project; tombstones stay", () => {
    const { store, cwd, dir } = fresh();
    const other = join(root, `other${n}`);
    store.add("user", cwd, { text: "Живёт в Казани", quote: "я живу в Казани" });
    store.add("project", cwd, { text: "Бот на Python", quote: "бот на Python" });
    store.add("project", other, { text: "Сайт пекарни", quote: "сайт пекарни" });
    store.setDigest(other, "Прошлый раз: шапка.");
    const f = store.add("user", cwd, { text: "Любит котов", quote: "люблю котов" });
    if (!f.ok) throw new Error("not added");
    store.forget(f.entry.id, cwd);
    store.eraseAll();
    expect(store.entries("user", cwd)).toEqual([]);
    expect(store.entries("project", cwd)).toEqual([]);
    expect(store.entries("project", other)).toEqual([]);
    expect(store.digest(other)).toBeUndefined();
    expect(store.history(cwd)).toEqual([]);
    const all = [userFile(dir), readFileSync(join(dir, "journal.jsonl"), "utf8")].join("\n");
    expect(all).not.toMatch(/Казан|Python|пекарн|шапка|кот/u);
    // Forgotten stays forgotten.
    expect(store.add("user", cwd, { text: "Любит котов", quote: "люблю котов" })).toEqual({
      ok: false,
      reason: "forgotten",
    });
  });

  it("card details in the agreed formats", () => {
    expect(MEMORY_CARD).toEqual({
      saved: "prsloy-memory.saved",
      updated: "prsloy-memory.updated",
      auto: "prsloy-memory.auto",
      confirm: "prsloy-memory.confirm",
    });
    const before = {
      id: "u-1",
      text: "Любит тёмные",
      quote: "q",
      origin: "user" as const,
      created: "",
      pinned: true,
    };
    const { pinned: _pinned, ...rest } = before;
    const after = { ...rest, id: "u-2", text: "Не любит тёмные" };
    expect(updatedDetails("op-1", "user", before, after)).toEqual({
      opId: "op-1",
      id: "u-2",
      scope: "user",
      before: "Любит тёмные",
      after: "Не любит тёмные",
      pinned: true,
    });
    expect(autoDetails([{ scope: "project", entry: { ...after, quote: "" } }])).toEqual({
      items: [{ id: "u-2", scope: "project", text: "Не любит тёмные" }],
    });
  });
});
