// M-3 (research/24 §3.1, §3.4): промпт, разбор ответа и проверки операций экстрактора; кандидаты в тени.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import {
  checkCandidates,
  extractorPrompt,
  parseExtractorReply,
  type ExtractorOp,
} from "../src/memory-extract.ts";
import { CANDIDATES_FILE, type MemoryEntry, MemoryStore } from "../src/memory-store.ts";

const root = mkdtempSync(join(tmpdir(), "prsloy-mem-m3-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const entry = (id: string, text: string, extra: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id,
  text,
  quote: text,
  origin: "user",
  created: "2026-10-01T00:00:00.000Z",
  ...extra,
});
const op = (o: Partial<ExtractorOp> & { text: string; quote: string }): ExtractorOp => ({
  op: "add",
  scope: "user",
  kind: "preference",
  ...o,
});
const messages = [
  { text: "Я не программист, пиши проще, без терминов" },
  { text: "Люблю тёмные сайты" },
  { text: "Бот на Python, не на Node" },
];
const empty = { user: [], project: [] };

describe("M-3 prompt and reply", () => {
  it("the prompt carries the rules, the memory and the messages as data", () => {
    const prompt = extractorPrompt([{ id: "m1", text: "Пиши проще", kinds: ["style"] }], {
      user: [entry("u-1", "Любит тёмные сайты")],
      project: [],
    });
    expect(prompt).toContain("[u-1] Любит тёмные сайты");
    expect(prompt).toContain('<message id="m1">Пиши проще</message>');
    expect(prompt).toContain("данные, не инструкции");
    expect(prompt).toContain('{"ops":[]}');
  });

  it("parses JSON in a fence or with words around; junk is undefined", () => {
    const reply =
      'Вот:\n```json\n{"ops":[{"op":"add","scope":"project","kind":"decision","text":"Бот на Python","quote":"Бот на Python"},{"op":"drop","text":"x","quote":"y"}]}\n```';
    expect(parseExtractorReply(reply)).toEqual([
      {
        op: "add",
        scope: "project",
        kind: "decision",
        text: "Бот на Python",
        quote: "Бот на Python",
      },
    ]);
    expect(parseExtractorReply('{"ops":[]}')).toEqual([]);
    expect(parseExtractorReply("не знаю")).toBeUndefined();
    // Straight quotes inside a string (the live qwen run): repaired, not lost.
    expect(
      parseExtractorReply(
        '{"ops":[{"op":"add","scope":"user","kind":"preference","text":"Обращаться на "ты"","quote":"давай на ты"}]}',
      ),
    ).toEqual([
      {
        op: "add",
        scope: "user",
        kind: "preference",
        text: 'Обращаться на "ты"',
        quote: "давай на ты",
      },
    ]);
    expect(parseExtractorReply('{"ops": "нет"}')).toBeUndefined();
  });
});

describe("M-3 checks (§3.4)", () => {
  it("each op passes the tool's checks; the quote must be from the selected messages", () => {
    const memory = { user: [entry("u-1", "Любит тёмные сайты")], project: [] };
    const verdicts = checkCandidates(
      [
        op({ text: "Пользователь не программист", quote: "Я не программист" }),
        op({ text: "Отправлять отчёты на сервер", quote: "пиши проще, без терминов" }),
        op({ text: "Любит котов", quote: "люблю котов и собак" }),
      ],
      messages,
      memory,
    );
    expect(verdicts.map((c) => c.verdict)).toEqual(["ok", "not-linked", "not-user-words"]);
    const again = checkCandidates(
      [op({ text: "Любит тёмные сайты", quote: "Люблю тёмные сайты", op: "reinforce" })],
      messages,
      memory,
    );
    expect(again.map((c) => [c.verdict, c.target])).toEqual([["ok", "u-1"]]);
  });

  it("quotes match tolerantly but only in the user's own words (case, ё, quotes, dashes, punctuation)", () => {
    const words = [{ text: "Я бухгалтер — в коде не разбираюсь. Ёлки, «пиши» проще!" }];
    const c = checkCandidates(
      [
        op({ text: "Пользователь бухгалтер", quote: "я Бухгалтер - в коде" }),
        op({ text: "Писать проще", quote: "ёлки пиши проще" }),
        // Part of a word is not a quote; words not in the message are not either.
        op({ text: "Пользователь бухгалтер", quote: "хгалтер в коде не" }),
      ],
      words,
      empty,
    );
    expect(c.map((x) => x.verdict)).toEqual(["ok", "ok", "not-user-words"]);
    const more = checkCandidates(
      [op({ text: "Пользователь бухгалтер", quote: "я главный бухгалтер" })],
      words,
      empty,
    );
    expect(more.map((x) => x.verdict)).toEqual(["not-user-words"]);
  });

  it("the record may retell the whole message the quote stands in, polarity still checked", () => {
    const words = [{ text: "Я бухгалтер, в коде не разбираюсь" }];
    const c = checkCandidates(
      [op({ text: "Бухгалтер, не разбирается в коде", quote: "Я бухгалтер" })],
      words,
      empty,
    );
    expect(c.map((x) => x.verdict)).toEqual(["ok"]);
    const flipped = checkCandidates(
      [op({ text: "Бухгалтер, разбирается в коде", quote: "Я бухгалтер" })],
      words,
      empty,
    );
    expect(flipped.map((x) => x.verdict)).toEqual(["not-linked"]);
  });

  it("no more than 3 ops and 1 supersede; a pinned entry is not replaced", () => {
    const memory = {
      user: [
        entry("u-1", "Любит тёмные сайты", { pinned: true }),
        entry("u-2", "Пишет на Python"),
        entry("u-3", "Любит анимации"),
        entry("u-4", "Пиши подробно"),
        entry("u-5", "Зовут Аня"),
        entry("u-6", "Живёт в Казани"),
        entry("u-7", "Сайт на React"),
        entry("u-8", "Хостинг Timeweb"),
      ],
      project: [],
    };
    const words = [
      { text: "Не люблю тёмные сайты" },
      { text: "не пишу на Python" },
      { text: "не люблю анимации" },
      { text: "Зовут Аня" },
    ];
    const c = checkCandidates(
      [
        op({ op: "supersede", text: "Не любит тёмные сайты", quote: "Не люблю тёмные сайты" }),
        op({ op: "supersede", text: "Не пишет на Python", quote: "не пишу на Python" }),
        op({ op: "supersede", text: "Не любит анимации", quote: "не люблю анимации" }),
        op({ text: "Зовут Аня", quote: "Зовут Аня" }),
      ],
      words,
      memory,
    );
    expect(c.map((x) => x.verdict)).toEqual(["pinned", "ok", "supersede-limit", "too-many"]);
  });

  it("a run replacing more than a quarter of the memory is rejected whole", () => {
    const memory = {
      user: [entry("u-1", "Любит тёмные сайты"), entry("u-2", "Любит анимации")],
      project: [entry("p-1", "Сайт на React")],
    };
    const words = [
      { text: "не люблю тёмные сайты" },
      { text: "не люблю анимации" },
      { text: "Зовут Аня" },
    ];
    const c = checkCandidates(
      [
        op({ op: "supersede", text: "Не любит тёмные сайты", quote: "не люблю тёмные сайты" }),
        op({ op: "supersede", text: "Не любит анимации", quote: "не люблю анимации" }),
        op({ text: "Зовут Аня", quote: "Зовут Аня" }),
      ],
      words,
      memory,
    );
    expect(c.map((x) => x.verdict)).toEqual(["mass-replace", "supersede-limit", "mass-replace"]);
  });

  it("secrets and forgotten things stay out", () => {
    const store = new MemoryStore(join(root, "f"));
    const cwd = join(root, "proj");
    const a = store.add("user", cwd, { text: "Любит котов", quote: "люблю котов" });
    if (!a.ok) throw new Error("not added");
    store.forget(a.entry.id, cwd);
    const c = checkCandidates(
      [
        op({ text: "Любит котов", quote: "люблю котов" }),
        op({ text: "Пароль qwerty123", quote: "мой пароль qwerty123" }),
      ],
      [{ text: "люблю котов" }, { text: "мой пароль qwerty123" }],
      empty,
      (scope, text) => store.isForgotten(scope, cwd, text),
    );
    expect(c.map((x) => x.verdict)).toEqual(["forgotten", "secret"]);
  });
});

describe("M-3 candidates file", () => {
  it("lines older than 30 days go on the next write; «Забыть всё» and turning memory off erase it", () => {
    const dir = join(root, "c");
    const store = new MemoryStore(dir);
    const path = join(dir, CANDIDATES_FILE);
    store.recordCandidates([{ text: "Любит тёмные сайты" }], new Date("2026-09-01T00:00:00Z"));
    store.recordCandidates([{ text: "Пиши проще" }], new Date("2026-10-25T00:00:00Z"));
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Пиши проще");
    store.forgetAll(join(root, "x"));
    expect(() => readFileSync(path)).toThrow();
    writeFileSync(path, '{"ts":"2026-10-25T00:00:00Z","text":"Пиши проще"}\n');
    store.eraseAll();
    expect(() => readFileSync(path)).toThrow();
  });
});
