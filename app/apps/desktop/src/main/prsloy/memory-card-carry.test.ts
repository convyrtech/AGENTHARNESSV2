import { afterEach, describe, expect, it } from "vite-plus/test";
import { carryUnsavedCards, onlyInProjectOf, projectOf } from "./memory-card-carry.ts";
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

// #73: chats are filed per project folder, so a card must never cross from one project to another.
const A = "/ud/agent/sessions/--home-u-проект-а--";
const B = "/ud/agent/sessions/--home-u-проект-б--";

describe("a memory card and the project of the chat", () => {
  let stop = () => {};
  afterEach(() => {
    stop();
    resetSessionTracking();
  });

  function setup() {
    const shown: { text: string; chat: string | undefined }[] = [];
    let chat: string | undefined;
    const carry = carryUnsavedCards(
      async (_type, text) => {
        shown.push({ text, chat });
      },
      { exists: () => false, delayMs: 5 },
    );
    stop = () => carry.stop();
    const go = (file: string) => {
      chat = file;
      trackSessionFile(file);
    };
    return { shown, carry, go };
  }

  it("«Новый чат» inside one project still carries the card", async () => {
    const { shown, carry, go } = setup();
    go(`${A}/new-1.jsonl`);
    await carry.note("prsloy-memory.auto", "Запомнил «Без анимаций»", {});
    go(`${A}/new-2.jsonl`);
    await wait(20);
    // The card was shown where it was written and carried inside the same project.
    expect(shown.map((s) => s.chat)).toEqual([`${A}/new-1.jsonl`, `${A}/new-2.jsonl`]);
  });

  it("a switch into another project does not show it there", async () => {
    const { shown, carry, go } = setup();
    go(`${A}/new-1.jsonl`);
    await carry.note("prsloy-memory.auto", "Запомнил «Без анимаций»", {});
    go(`${B}/chat.jsonl`);
    await wait(20);
    // Only where it belongs; nothing lands in the other project.
    expect(shown.map((s) => s.chat)).toEqual([`${A}/new-1.jsonl`]);
  });

  it("a switch back into the first project does not bring it along either", async () => {
    const { shown, carry, go } = setup();
    go(`${A}/new-1.jsonl`);
    await carry.note("prsloy-memory.auto", "Запомнил", {});
    go(`${B}/chat.jsonl`);
    go(`${A}/another.jsonl`);
    await wait(20);
    expect(shown.map((s) => s.chat)).toEqual([`${A}/new-1.jsonl`]);
  });

  it("a plain conversation and a project are different places", async () => {
    const { shown, carry, go } = setup();
    go("/ud/agent/sessions/прямой.jsonl");
    await carry.note("prsloy-memory.auto", "Запомнил", {});
    go(`${A}/chat.jsonl`);
    await wait(20);
    expect(shown.map((s) => s.chat)).toEqual(["/ud/agent/sessions/прямой.jsonl"]);
  });

  it("the project is the folder of the chat file, whatever the separators", () => {
    expect(projectOf("C:\\ud\\sessions\\--proj--\\a.jsonl")).toBe(
      projectOf("C:/ud/sessions/--proj--/b.jsonl"),
    );
    expect(projectOf(`${A}/a.jsonl`)).not.toBe(projectOf(`${B}/a.jsonl`));
  });
});

describe("a card that names a project entry (the extractor runs after the person left)", () => {
  let stop = () => {};
  afterEach(() => {
    stop();
    resetSessionTracking();
  });

  const card = (scope: "user" | "project") => ({
    items: [{ id: "x", scope, text: "Запоминаю", quote: "запомни" }],
  });

  function setup(from: string) {
    const shown: { text: string; chat: string | undefined }[] = [];
    let chat: string | undefined;
    const tracked = onlyInProjectOf(from, async (_type, text) => {
      shown.push({ text, chat });
    });
    const note = carryUnsavedCards(tracked, { exists: () => false, delayMs: 5 });
    stop = () => note.stop();
    const go = (file: string) => {
      chat = file;
      trackSessionFile(file);
    };
    return { shown, note, go };
  }

  it("the chat moved into another project meanwhile — the card is not shown there", async () => {
    const t = setup(`${A}/left.jsonl`);
    t.go(`${B}/chat.jsonl`);
    await t.note.note(
      "prsloy-memory.auto",
      "Заметил и запомнил «Делаем на Python»",
      card("project"),
    );
    expect(t.shown).toEqual([]);
  });

  it("still in the same project — shown", async () => {
    const t = setup(`${A}/left.jsonl`);
    t.go(`${A}/next.jsonl`);
    await t.note.note(
      "prsloy-memory.auto",
      "Заметил и запомнил «Делаем на Python»",
      card("project"),
    );
    expect(t.shown).toEqual([
      { text: "Заметил и запомнил «Делаем на Python»", chat: `${A}/next.jsonl` },
    ]);
  });

  it("a card about the person itself is shown in any project", async () => {
    const t = setup(`${A}/left.jsonl`);
    t.go(`${B}/chat.jsonl`);
    await t.note.note("prsloy-memory.auto", "Заметил и запомнил «Пиши проще»", card("user"));
    expect(t.shown).toEqual([{ text: "Заметил и запомнил «Пиши проще»", chat: `${B}/chat.jsonl` }]);
  });

  it("no chat tracked yet — nothing is dropped on a guess", async () => {
    const t = setup(`${A}/left.jsonl`);
    await t.note.note(
      "prsloy-memory.auto",
      "Заметил и запомнил «Делаем на Python»",
      card("project"),
    );
    expect(t.shown).toEqual([{ text: "Заметил и запомнил «Делаем на Python»", chat: undefined }]);
  });
});
