import { afterEach, describe, expect, it } from "vite-plus/test";
import { carryUnsavedCards } from "./memory-card-carry.ts";
import { resetSessionTracking, trackSessionFile } from "./session-left.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("a memory card in a chat that is never saved", () => {
  let stop = () => {};
  afterEach(() => {
    stop();
    resetSessionTracking();
  });

  function setup(saved: Set<string>) {
    const shown: { text: string; chat: string | undefined }[] = [];
    let chat: string | undefined;
    const carry = carryUnsavedCards(
      async (_type, text) => {
        shown.push({ text, chat });
      },
      { exists: (f) => saved.has(f), delayMs: 5 },
    );
    stop = () => carry.stop();
    const go = (file: string) => {
      chat = file;
      trackSessionFile(file);
    };
    return { shown, carry, go };
  }

  it("moves to the chat that replaced it right after «Новый чат»", async () => {
    const saved = new Set(["left.jsonl"]);
    const { shown, carry, go } = setup(saved);
    go("left.jsonl");
    go("new-1.jsonl");
    await carry.note("prsloy-memory.auto", "Заметил и запомнил «Без анимаций»", {});
    go("new-2.jsonl");
    await wait(20);
    expect(shown).toEqual([
      { text: "Заметил и запомнил «Без анимаций»", chat: "new-1.jsonl" },
      { text: "Заметил и запомнил «Без анимаций»", chat: "new-2.jsonl" },
    ]);
  });

  it("stays where it was once that chat is saved", async () => {
    const saved = new Set(["left.jsonl"]);
    const { shown, carry, go } = setup(saved);
    go("left.jsonl");
    go("new-1.jsonl");
    await carry.note("prsloy-memory.auto", "Запомнил", {});
    saved.add("new-1.jsonl");
    go("other.jsonl");
    await wait(20);
    expect(shown.map((s) => s.chat)).toEqual(["new-1.jsonl"]);
  });

  it("a card in a saved chat is never carried", async () => {
    const saved = new Set(["left.jsonl", "a.jsonl"]);
    const { shown, carry, go } = setup(saved);
    go("a.jsonl");
    await carry.note("prsloy-memory.auto", "Запомнил", {});
    go("b.jsonl");
    await wait(20);
    expect(shown).toHaveLength(1);
  });

  it("moving on again before the delay carries it once more, not twice", async () => {
    const { shown, carry, go } = setup(new Set());
    go("n1.jsonl");
    await carry.note("prsloy-memory.auto", "Запомнил", {});
    go("n2.jsonl");
    go("n3.jsonl");
    await wait(20);
    expect(shown.map((s) => s.chat)).toEqual(["n1.jsonl", "n3.jsonl"]);
  });
});
