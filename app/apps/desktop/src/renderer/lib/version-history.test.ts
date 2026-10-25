import type { PrsloyTurnSnapshot } from "@zeno/contracts";
import { describe, expect, it } from "vite-plus/test";
import { HISTORY_LIMIT, historyEntries, historyTime, historyWhat } from "./version-history.ts";

const snap = (id: string, createdAt: string, extra: Partial<PrsloyTurnSnapshot> = {}) =>
  ({ id, turn: 1, createdAt, kind: "turn", ...extra }) as PrsloyTurnSnapshot;

describe("version history", () => {
  it("lists newest first, keeps undo backups, drops broken dates, caps the list", () => {
    const list = historyEntries([
      snap("a", "2026-10-24T18:40:00"),
      snap("b", "2026-10-25T10:05:00", { kind: "undo-backup" }),
      snap("c", "не дата"),
    ]);
    expect(list.map((s) => s.id)).toEqual(["b", "a"]);
    const many = Array.from({ length: 80 }, (_, i) =>
      snap(String(i), new Date(2026, 9, 1, 0, i).toISOString()),
    );
    expect(historyEntries(many)).toHaveLength(HISTORY_LIMIT);
    expect(historyEntries(many)[0]?.id).toBe("79");
  });

  it("names a version by its request", () => {
    expect(historyWhat("ru", snap("a", "x", { prompt: "сделай меню" }))).toBe("сделай меню");
    expect(historyWhat("ru", snap("a", "x", { prompt: "  " }))).toBe("(без текста)");
    expect(historyWhat("ru", snap("a", "x", { kind: "undo-backup" }))).toBe("Перед откатом");
  });

  it("says today, yesterday, or the date", () => {
    const now = new Date(2026, 9, 25, 12, 0);
    expect(historyTime("ru", new Date(2026, 9, 25, 10, 5).toISOString(), now)).toBe(
      "сегодня 10:05",
    );
    expect(historyTime("ru", new Date(2026, 9, 24, 18, 40).toISOString(), now)).toBe("вчера 18:40");
    expect(historyTime("ru", new Date(2026, 9, 12, 9, 30).toISOString(), now)).toMatch(
      /^12 окт\.?, 09:30$/u,
    );
  });
});
