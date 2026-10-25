import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { fileKind, LineSplitter, parseHarnessLine } from "./events.ts";

const RECORDED = join(import.meta.dirname, "../../../e2e/design/recorded.jsonl");
const noFiles = () => undefined;

describe("LineSplitter", () => {
  it("keeps a partial line until its newline arrives", () => {
    const s = new LineSplitter();
    expect(s.push('{"ev":"no')).toEqual([]);
    expect(s.push('te","text":"a"}\n{"ev"')).toEqual(['{"ev":"note","text":"a"}']);
    expect(s.push(':"done"}\r\n\n')).toEqual(['{"ev":"done"}']);
    expect(s.flush()).toEqual([]);
  });

  it("returns the unterminated tail on flush", () => {
    const s = new LineSplitter();
    s.push('{"ev":"done"}');
    expect(s.flush()).toEqual(['{"ev":"done"}']);
  });
});

describe("parseHarnessLine", () => {
  it("parses every event of a real run.py log (stage, tool, owner, stuck)", () => {
    const lines = readFileSync(RECORDED, "utf8").trim().split("\n");
    const kinds = new Set<string>();
    for (const line of lines) {
      const rec = JSON.parse(line) as { event: unknown };
      const ev = parseHarnessLine(JSON.stringify(rec.event), (p) =>
        p.startsWith("{WS}/") ? { path: p.slice(5), url: `x:${p}`, kind: fileKind(p) } : undefined,
      );
      expect(ev, line).toBeDefined();
      kinds.add(ev!.ev);
    }
    expect([...kinds].sort()).toEqual(["note", "owner", "stage", "stuck", "tool"]);
  });

  it("maps owner files through the workspace guard and drops outsiders", () => {
    const ev = parseHarnessLine(
      JSON.stringify({
        ev: "owner",
        text: "Какое берём?",
        files: ["/ws/design/a.png", "/etc/passwd", "/ws/design/a.png", 7],
        options: [
          { q: "", options: [{ key: "A", label: "Тёплое" }, { key: "", label: "x" }, "bad"] },
        ],
      }),
      (p) => (p.startsWith("/ws/") ? { path: p.slice(4), url: "u", kind: fileKind(p) } : undefined),
    );
    expect(ev).toEqual({
      ev: "owner",
      text: "Какое берём?",
      files: [{ path: "design/a.png", url: "u", kind: "image" }],
      options: [{ q: "", options: [{ key: "A", label: "Тёплое" }] }],
    });
  });

  it("drops the agent's «(рекомендую)» from a recommended label: the card has its own badge", () => {
    const ev = parseHarnessLine(
      JSON.stringify({
        ev: "owner",
        text: "x",
        options: [
          {
            q: "",
            options: [
              { key: "A", label: "Кольцо и счётчик (рекомендую)", recommended: true },
              { key: "B", label: "Выдача — рекомендую", recommended: true },
              { key: "C", label: "(рекомендую)", recommended: true },
              { key: "D", label: "Без пометки (рекомендую)" },
            ],
          },
        ],
      }),
      () => undefined,
    );
    if (ev?.ev !== "owner") throw new Error("no owner");
    expect(ev.options[0]!.options.map((o) => o.label)).toEqual([
      "Кольцо и счётчик",
      "Выдача",
      "(рекомендую)",
      "Без пометки (рекомендую)",
    ]);
  });

  it("reads grouped options and turns an old flat list into one group", () => {
    const grouped = parseHarnessLine(
      JSON.stringify({
        ev: "owner",
        text: "?",
        files: [],
        options: [
          {
            q: "Для кого?",
            options: [{ key: "А", label: "Гости", recommended: true }, { key: "Б" }],
          },
          { q: "", options: [] },
          { q: "2", options: [{ key: "А", label: "x" }] },
          { q: "3", options: [{ key: "А", label: "x" }] },
          { q: "4", options: [{ key: "А", label: "x" }] },
        ],
      }),
      noFiles,
    );
    expect(grouped?.ev === "owner" && grouped.options).toEqual([
      { q: "Для кого?", options: [{ key: "А", label: "Гости", recommended: true }] },
      { q: "2", options: [{ key: "А", label: "x" }] },
      { q: "3", options: [{ key: "А", label: "x" }] },
    ]);
    const flat = parseHarnessLine(
      '{"ev":"owner","text":"","files":[],"options":[{"key":"A","label":"a"}]}',
      noFiles,
    );
    expect(flat?.ev === "owner" && flat.options).toEqual([
      { q: "", options: [{ key: "A", label: "a" }] },
    ]);
  });

  it("drops non-events and clamps long fields", () => {
    expect(parseHarnessLine("Traceback (most recent call last):", noFiles)).toBeUndefined();
    expect(parseHarnessLine('{"ws": "/x", "page": "landing"}', noFiles)).toBeUndefined();
    expect(parseHarnessLine("[1,2]", noFiles)).toBeUndefined();
    const ev = parseHarnessLine(
      JSON.stringify({ ev: "note", text: "я".repeat(10_000), t: 5 }),
      noFiles,
    );
    expect(ev?.ev === "note" && ev.text.length).toBe(4000);
    expect(ev?.t).toBe(5);
    expect(parseHarnessLine('{"ev":"stage","gate":"2","attempt":"x"}', noFiles)).toEqual({
      ev: "stage",
      gate: "2",
      title: "",
      model: "",
      attempt: 1,
    });
  });
});

describe("fileKind", () => {
  it("classifies what the owner card can show", () => {
    expect(fileKind("a/B.PNG")).toBe("image");
    expect(fileKind("v.webm")).toBe("video");
    expect(fileKind("site/index.html")).toBe("page");
    expect(fileKind("notes.md")).toBe("other");
  });
});

describe("run.py word options", () => {
  it("keeps a word key whole: the button sends it back as the answer", () => {
    const ev = parseHarnessLine(
      JSON.stringify({
        ev: "owner",
        text: "Берём его или экран с тремя шагами?",
        files: [],
        options: [
          {
            q: "",
            options: [
              { key: "Берём его", label: "Берём его", recommended: true },
              { key: "экран с тремя шагами", label: "Экран с тремя шагами" },
            ],
          },
        ],
      }),
      () => undefined,
    );
    expect(ev && ev.ev === "owner" ? ev.options[0]?.options.map((o) => o.key) : []).toEqual([
      "Берём его",
      "экран с тремя шагами",
    ]);
  });
});
