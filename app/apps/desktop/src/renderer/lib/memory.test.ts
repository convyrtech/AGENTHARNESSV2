import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  findEntryId,
  memoryApi,
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
});

describe("memory v2 cards", () => {
  it("reads the auto card's entries, dropping broken ones", async () => {
    const { parseAutoDetails } = await import("./memory.ts");
    expect(
      parseAutoDetails({
        items: [
          { id: "a-1", scope: "project", text: "Сайт без сборщиков", quote: "не надо npm" },
          { id: "a-2", text: "Пишет коротко" },
          { id: "", text: "нет id" },
          { id: "a-3" },
          null,
        ],
      }),
    ).toEqual([
      { id: "a-1", scope: "project", text: "Сайт без сборщиков", quote: "не надо npm" },
      { id: "a-2", scope: "user", text: "Пишет коротко" },
    ]);
    expect(parseAutoDetails(undefined)).toEqual([]);
  });

  it("reads the update card; without opId or texts there is nothing to undo", async () => {
    const { parseUpdatedDetails } = await import("./memory.ts");
    expect(
      parseUpdatedDetails({
        opId: "op-1",
        id: "u-1",
        before: "тёмные",
        after: "светлые",
        pinned: true,
      }),
    ).toEqual({
      opId: "op-1",
      id: "u-1",
      scope: "user",
      before: "тёмные",
      after: "светлые",
      pinned: true,
    });
    expect(parseUpdatedDetails({ opId: "op-1", before: "a" })).toBeUndefined();
  });

  it("dates entries, with the year only when it is not this one", async () => {
    const { memoryDate } = await import("./memory.ts");
    const now = new Date(2026, 9, 25);
    expect(memoryDate("ru-RU", new Date(2026, 9, 12).toISOString(), now)).toMatch(/^12 окт\.?$/u);
    expect(memoryDate("ru-RU", new Date(2025, 0, 3).toISOString(), now)).toMatch(/2025/u);
    expect(memoryDate("ru-RU", undefined, now)).toBe("");
  });

  it("knows the v2 card types", () => {
    expect(memoryCardKind("prsloy-memory.auto")).toBe("auto");
    expect(memoryCardKind("prsloy-memory.updated")).toBe("updated");
  });
});
