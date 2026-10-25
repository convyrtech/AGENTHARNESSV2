// #14 (research/24 §3.5, research/27 §2): источник записи и «забыть всё из этого чата», забывание по виду записи
// и рабочим дням, вытеснение слабых автоматических записей, подтверждение изменений, предложенных агентом.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { ACTIVE_DAYS_FILE, MEMORY_LIMITS, MemoryStore, PENDING_FILE } from "../src/memory-store.ts";

const root = mkdtempSync(join(tmpdir(), "prsloy-mem-m4-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
function fresh() {
  const dir = join(root, `m${++n}`);
  return { store: new MemoryStore(dir), dir, cwd: join(root, `p${n}`) };
}
const userFile = (dir: string) => JSON.parse(readFileSync(join(dir, "user.json"), "utf8"));
/** Working days: the last `count` days before today, plus today. */
function activeDays(dir: string, count: number) {
  const days: string[] = [];
  for (let i = count; i >= 0; i--)
    days.push(new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10));
  writeFileSync(join(dir, ACTIVE_DAYS_FILE), JSON.stringify({ days }));
}
/** Set lastSeen of every entry `daysAgo` calendar days back. */
function age(dir: string, daysAgo: number) {
  const file = userFile(dir);
  const at = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  for (const e of file.entries) e.lastSeen = at;
  writeFileSync(join(dir, "user.json"), JSON.stringify(file));
}

describe("#14: where an entry came from", () => {
  it("evidence keeps the session and the message; «forget this chat» works per source", () => {
    const { store, cwd } = fresh();
    store.add("user", cwd, {
      text: "Любит тёмные сайты",
      quote: "люблю тёмные сайты",
      session: "chat-a",
      message: "m1",
    });
    store.add("user", cwd, { text: "Пиши проще", quote: "пиши проще", session: "chat-a" });
    store.add("user", cwd, { text: "Пиши проще", quote: "пиши проще, прошу", session: "chat-b" });
    store.add("user", cwd, { text: "Зовут Аня", quote: "зови меня Аня", session: "chat-b" });
    expect(store.entries("user", cwd)[0]!.evidence).toMatchObject([
      { quote: "люблю тёмные сайты", session: "chat-a", message: "m1" },
    ]);
    const { forgotten, weakened } = store.forgetSource("chat-a", cwd);
    expect(forgotten.map((e) => e.text)).toEqual(["Любит тёмные сайты"]);
    expect(weakened.map((e) => [e.text, e.strength, e.evidence?.map((x) => x.session)])).toEqual([
      ["Пиши проще", 1, ["chat-b"]],
    ]);
    expect(store.entries("user", cwd).map((e) => e.text)).toEqual(["Пиши проще", "Зовут Аня"]);
    // Reversible: the forgotten one is in «Было» with its opId.
    const [item] = store.history(cwd);
    expect(item).toMatchObject({ kind: "forgotten", entry: { text: "Любит тёмные сайты" } });
    expect(store.revert(item!.opId, cwd)?.text).toBe("Любит тёмные сайты");
  });
});

describe("#14 M-4: forgetting by kind and working days", () => {
  it("auto preferences go after 30 × strength working days; the rest stay", () => {
    const { store, dir, cwd } = fresh();
    store.add("user", cwd, { text: "Любит тёмные сайты", quote: "люблю тёмные", origin: "auto" });
    store.add("user", cwd, {
      text: "Пишет на Python",
      quote: "пишу на Python",
      origin: "auto",
      kind: "profile",
    });
    store.add("user", cwd, { text: "Пиши проще", quote: "пиши проще" });
    const pinned = store.add("user", cwd, {
      text: "Без анимаций",
      quote: "без анимаций",
      origin: "auto",
    });
    if (!pinned.ok) throw new Error("not added");
    store.pin(pinned.entry.id, true, cwd);
    age(dir, 400);
    // A long break with few working days forgets nothing.
    activeDays(dir, 20);
    expect(store.expire(cwd)).toEqual([]);
    activeDays(dir, 31);
    expect(store.expire(cwd).map((e) => e.text)).toEqual(["Любит тёмные сайты"]);
    expect(store.entries("user", cwd).map((e) => e.text)).toEqual([
      "Пишет на Python",
      "Пиши проще",
      "Без анимаций",
    ]);
    const [item] = store.history(cwd);
    expect(item).toMatchObject({ kind: "expired", entry: { text: "Любит тёмные сайты" } });
    expect(store.revert(item!.opId, cwd)?.text).toBe("Любит тёмные сайты");
  });

  it("strength buys time, capped at 180 working days", () => {
    const { store, dir, cwd } = fresh();
    for (const quote of ["люблю тёмные", "мне нравятся тёмные", "тёмные люблю"])
      store.add("user", cwd, { text: "Любит тёмные сайты", quote, origin: "auto" });
    expect(store.entries("user", cwd)[0]!.strength).toBe(3);
    age(dir, 400);
    activeDays(dir, 85);
    expect(store.expire(cwd)).toEqual([]);
    activeDays(dir, 91);
    expect(store.expire(cwd)).toHaveLength(1);

    const strong = fresh();
    for (let i = 0; i < 8; i++)
      strong.store.add("user", strong.cwd, {
        text: "Любит тёмные сайты",
        quote: `люблю тёмные сайты ${"очень ".repeat(i)}`,
        origin: "auto",
      });
    age(strong.dir, 400);
    activeDays(strong.dir, 181);
    expect(strong.store.expire(strong.cwd)).toHaveLength(1);
  });

  it("touchActiveDay counts each day once", () => {
    const { store } = fresh();
    store.touchActiveDay(new Date("2026-10-20T10:00:00Z"));
    store.touchActiveDay(new Date("2026-10-20T18:00:00Z"));
    store.touchActiveDay(new Date("2026-10-22T09:00:00Z"));
    expect(store.activeDaysSince("2026-10-19T00:00:00Z")).toBe(2);
    expect(store.activeDaysSince("2026-10-20T12:00:00Z")).toBe(1);
  });

  it("full memory: the weakest auto entry makes room; user entries never do", () => {
    const { store, cwd } = fresh();
    const words = [
      "Анна",
      "Борис",
      "Вера",
      "Глеб",
      "Дина",
      "Егор",
      "Жанна",
      "Зоя",
      "Игорь",
      "Кира",
      "Лев",
    ];
    for (const [i, w] of words.entries())
      store.add("user", cwd, {
        text: `Друг ${w}`,
        quote: `друг ${w}`,
        ...(i < 2 ? { origin: "auto" as const } : {}),
      });
    store.add("user", cwd, { text: "Друг Анна", quote: "друг Анна, правда", origin: "auto" });
    expect(store.entries("user", cwd)).toHaveLength(MEMORY_LIMITS.user.entries - 1);
    store.add("user", cwd, { text: "Подруга Мила", quote: "подруга Мила" });
    const r = store.add("user", cwd, { text: "Сосед Олег", quote: "сосед Олег" });
    expect(r.ok && r.evicted?.map((e) => e.text)).toEqual(["Друг Борис"]);
    expect(store.history(cwd)[0]).toMatchObject({ kind: "expired", entry: { text: "Друг Борис" } });
    // Only user entries left with a weak one gone: the next one is refused.
    store.add("user", cwd, { text: "Коллега Нина", quote: "коллега Нина" });
    const full = store.add("user", cwd, { text: "Брат Паша", quote: "брат Паша" });
    expect(full).toEqual({ ok: false, reason: "full" });
  });
});

describe("#14: the agent proposes, the user decides", () => {
  it("pending changes expire after a day and are erased with the memory", () => {
    const { store, dir, cwd } = fresh();
    const a = store.add("user", cwd, { text: "Любит тёмные сайты", quote: "люблю тёмные" });
    if (!a.ok) throw new Error("not added");
    const id = store.propose({
      action: "forget",
      scope: "user",
      target: a.entry.id,
      text: a.entry.text,
    });
    expect(store.confirm(id, false, cwd)?.applied).toBeUndefined();
    expect(store.entries("user", cwd)).toHaveLength(1);
    const old = store.propose({ action: "forget", scope: "user", target: a.entry.id, text: "x" });
    const file = JSON.parse(readFileSync(join(dir, PENDING_FILE), "utf8"));
    file.items[0].at = new Date(Date.now() - 25 * 3_600_000).toISOString();
    writeFileSync(join(dir, PENDING_FILE), JSON.stringify(file));
    expect(store.confirm(old, true, cwd)).toBeUndefined();
    expect(store.entries("user", cwd)).toHaveLength(1);
    store.propose({ action: "forget", scope: "user", target: a.entry.id, text: a.entry.text });
    store.eraseAll();
    expect(() => readFileSync(join(dir, PENDING_FILE))).toThrow();
  });

  it("add with replace:false reports the conflict instead of replacing", () => {
    const { store, cwd } = fresh();
    store.add("user", cwd, { text: "Любит тёмные сайты", quote: "люблю тёмные" });
    const r = store.add("user", cwd, {
      text: "Не любит тёмные сайты",
      quote: "не люблю тёмные",
      replace: false,
    });
    expect(r).toMatchObject({
      ok: false,
      reason: "conflict",
      existing: { text: "Любит тёмные сайты" },
    });
    expect(store.entries("user", cwd).map((e) => e.text)).toEqual(["Любит тёмные сайты"]);
  });
});
