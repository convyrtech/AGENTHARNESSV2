import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  findEntryId,
  markMemoryHintSeen,
  memoryApi,
  memoryHintSeen,
  memoryCardId,
  memoryCardKind,
  restoreLeftMs,
  savedCardText,
} from "./memory.ts";

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

const snapshot = {
  user: [{ id: "u-1", text: "Отвечать коротко" }],
  project: [{ id: "p-1", text: "Сайт без сборщиков" }],
  forgotten: [],
};

describe("memory cards", () => {
  it("knows the harness's four cards and nothing else", () => {
    expect(memoryCardKind("prsloy-memory.saved")).toBe("saved");
    expect(memoryCardKind("prsloy-memory.full")).toBe("full");
    expect(memoryCardKind("prsloy-harness.budget")).toBeUndefined();
    expect(memoryCardKind(undefined)).toBeUndefined();
  });

  it("reads the id from details, the text from the card", () => {
    expect(memoryCardId({ id: "u-1", scope: "user" })).toBe("u-1");
    expect(memoryCardId({ id: 3 })).toBeUndefined();
    expect(memoryCardId(undefined)).toBeUndefined();
    expect(savedCardText("Запомнил: Отвечать коротко")).toBe("Отвечать коротко");
    expect(savedCardText("Запомнил для этого проекта: Сайт без сборщиков")).toBe(
      "Сайт без сборщиков",
    );
  });

  it("finds a history card's entry by its text", () => {
    expect(findEntryId(snapshot, "Сайт без сборщиков")).toBe("p-1");
    expect(findEntryId(snapshot, "чего нет")).toBeUndefined();
  });

  it("offers «Вернуть» for ten seconds", () => {
    const at = "2026-10-25T10:00:00.000Z";
    expect(restoreLeftMs(at, Date.parse(at) + 3_000)).toBe(7_000);
    expect(restoreLeftMs(at, Date.parse(at) + 11_000)).toBe(0);
    expect(restoreLeftMs(undefined, 0)).toBe(0);
  });

  it("has no api until main serves it", () => {
    (globalThis as { window?: unknown }).window = { zeno: {} };
    expect(memoryApi()).toBeUndefined();
    const api = { list: () => Promise.resolve(snapshot) };
    (globalThis as { window?: unknown }).window = { zeno: { memory: api } };
    expect(memoryApi()).toBe(api);
  });

  it("the first-card hint is remembered; no storage means no hint", () => {
    const store = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    };
    expect(memoryHintSeen()).toBe(false);
    markMemoryHintSeen();
    expect(memoryHintSeen()).toBe(true);
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
    };
    expect(memoryHintSeen()).toBe(true);
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });
});
