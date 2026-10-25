import { beforeEach, describe, expect, it } from "vite-plus/test";
import { loadUndoOutcome, saveUndoOutcome } from "./undo-log.ts";

describe("undo log", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, String(v)),
        removeItem: (k: string) => void store.delete(k),
      },
    });
  });

  it("remembers an undo and a later restore", () => {
    expect(loadUndoOutcome("s1")).toBeUndefined();
    saveUndoOutcome("s1", { kind: "undone", count: 3, backupId: "b1" });
    expect(loadUndoOutcome("s1")).toEqual({ kind: "undone", count: 3, backupId: "b1" });
    saveUndoOutcome("s1", { kind: "restored", count: 3 });
    expect(loadUndoOutcome("s1")).toEqual({ kind: "restored", count: 3 });
  });

  it("keeps at most 200 entries, dropping the oldest", () => {
    for (let i = 0; i < 205; i += 1) saveUndoOutcome(`s${i}`, { kind: "undone", count: i });
    expect(loadUndoOutcome("s0")).toBeUndefined();
    expect(loadUndoOutcome("s4")).toBeUndefined();
    expect(loadUndoOutcome("s5")).toEqual({ kind: "undone", count: 5 });
    expect(loadUndoOutcome("s204")).toEqual({ kind: "undone", count: 204 });
  });

  it("ignores a broken store", () => {
    localStorage.setItem("prsloy.undo.log.v1", "{oops");
    expect(loadUndoOutcome("s1")).toBeUndefined();
    localStorage.setItem("prsloy.undo.log.v1", JSON.stringify({ s1: { kind: "weird" } }));
    expect(loadUndoOutcome("s1")).toBeUndefined();
  });
});
