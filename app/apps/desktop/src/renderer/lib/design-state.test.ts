import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DesignEvent } from "@zeno/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  DESIGN_STEPS,
  EMPTY_DESIGN_VIEW,
  elapsedMinutes,
  foldDesign,
  openQuestion,
  ownerText,
  reduceDesign,
  stepOf,
  tickerLine,
} from "./design-state.ts";
import { messages } from "./i18n.ts";

const RECORDED = join(import.meta.dirname, "../../../e2e/design/recorded.jsonl");

/** The recorded run.py log as main would relay it, turn by turn with user + exit around it. */
function recordedTurns(): DesignEvent[][] {
  const turns: DesignEvent[][] = [];
  for (const line of readFileSync(RECORDED, "utf8").trim().split("\n")) {
    const rec = JSON.parse(line) as {
      turn: number;
      say: string;
      files: string[];
      event: DesignEvent;
    };
    const turn = (turns[rec.turn - 1] ??= [{ ev: "user", text: rec.say, files: rec.files }]);
    const ev = rec.event;
    turn.push(
      ev.ev === "owner"
        ? {
            ...ev,
            files: (ev.files as unknown as string[]).map((p) => ({
              path: p.replace("{WS}/", ""),
              url: `prsloy-design://ws/0123456789abcdef/${p.replace("{WS}/", "")}`,
              kind: "image" as const,
            })),
          }
        : ev,
    );
  }
  return turns.map((t) => [...t, { ev: "exit", code: 0, cancelled: false }]);
}

describe("steps", () => {
  it("covers each pipeline gate exactly once, in flow.py order", () => {
    const order = ["0", "0a", "1", "2", "2a", "3", "4", "5", "6", "7", "8"];
    expect(DESIGN_STEPS.flatMap((s) => s.gates)).toEqual(order);
    expect(stepOf("2")).toEqual({ index: 2, total: 8, key: "design.step.brand" });
    expect(stepOf("9")).toBeUndefined();
  });

  it("has a label for every step in every locale", () => {
    for (const table of Object.values(messages)) {
      for (const s of DESIGN_STEPS) expect(table[s.key]).toBeTruthy();
    }
  });
});

describe("reduceDesign on a recorded run.py log", () => {
  const turns = recordedTurns();

  it("turn 1: progress while running, then a question card without options", () => {
    let v = EMPTY_DESIGN_VIEW;
    const [user, stage, tool] = turns[0]!;
    v = reduceDesign(v, user!, 1000);
    expect(v.running).toBe(true);
    v = reduceDesign(v, stage!, 1000);
    expect(v.stage).toMatchObject({ gate: "0", attempt: 1, since: 1000 });
    v = reduceDesign(v, tool!);
    expect(v.ticker).toEqual(["bash flow.py --page design/landing"]);
    for (const e of turns[0]!.slice(3)) v = reduceDesign(v, e);
    expect(v.running).toBe(false);
    expect(v.stage).toBeUndefined();
    expect(v.items.map((i) => i.kind)).toEqual(["user", "owner"]);
    expect(openQuestion(v)?.options).toEqual([]);
  });

  it("turn 2 answers the first card and opens a choice with a picture", () => {
    const v = foldDesign([...turns[0]!, ...turns[1]!], false);
    expect(v.items.map((i) => i.kind)).toEqual(["user", "owner", "user", "owner"]);
    const first = v.items[1]!;
    expect(first.kind === "owner" && first.answered).toBe(true);
    const q = openQuestion(v)!;
    expect(q.options.map((o) => o.key)).toEqual(["A", "B", "C"]);
    expect(q.files[0]!.path).toBe("design/landing/00-moods.png");
  });

  it("turn 3 climbs the ladder and ends stuck; nothing is left open", () => {
    const v = foldDesign(turns.slice(0, 3).flat(), false);
    expect(v.items.at(-1)?.kind).toBe("stuck");
    expect(openQuestion(v)).toBeUndefined();
  });

  it("a turn without question, done or stuck becomes «continue»", () => {
    const v = foldDesign(
      [
        { ev: "user", text: "дальше", files: [] },
        { ev: "stage", gate: "3", title: "", model: "", attempt: 1 },
        { ev: "note", text: "на этот ход шагов хватит; продолжу по следующему сообщению" },
        { ev: "exit", code: 0, cancelled: false },
      ],
      false,
    );
    expect(v.items.at(-1)?.kind).toBe("paused");
  });

  it("cancel and crash are their own items", () => {
    const base: DesignEvent[] = [{ ev: "user", text: "x", files: [] }];
    expect(
      foldDesign([...base, { ev: "exit", code: null, cancelled: true }], false).items.at(-1)?.kind,
    ).toBe("cancelled");
    const crashed = foldDesign(
      [...base, { ev: "exit", code: 1, cancelled: false, error: "Traceback" }],
      false,
    );
    expect(crashed.items.at(-1)).toMatchObject({ kind: "error", detail: "Traceback" });
  });

  it("history of a run still going keeps the progress line", () => {
    const v = foldDesign(turns[2]!.slice(0, 4), true);
    expect(v.running).toBe(true);
    expect(v.stage?.gate).toBe("0");
  });
});

describe("tickerLine", () => {
  it("shows the path or command, not the JSON", () => {
    expect(tickerLine("read", '{"path": "design/landing/STATUS.md"}')).toBe(
      "read design/landing/STATUS.md",
    );
    expect(tickerLine("write", '{"content": "…", "path": "a.md"}')).toBe("write a.md");
    expect(tickerLine("edit", '{"newText": "b", "oldText": "a", "path": "design/la')).toBe(
      "edit design/la",
    );
    expect(tickerLine("bash", "python3 -I design-pipeline/tools/gate.py --url x")).toBe(
      "bash gate.py --url x",
    );
  });
});

describe("ownerText", () => {
  it("drops option lines and picture paths shown as buttons and pictures", () => {
    const files = [{ path: "design/landing/00-moods.png", url: "u", kind: "image" as const }];
    const text =
      "Собрал три настроения из вашего логотипа: design/landing/00-moods.png\nA. Тёплое утро\nB. Ночь\nРекомендую A. Какое берём?";
    expect(ownerText(text, files, [{ key: "A", label: "Тёплое утро" }])).toBe(
      "Собрал три настроения из вашего логотипа.\nРекомендую A. Какое берём?",
    );
    expect(ownerText("Пришлите, что есть: скрины", [], [])).toBe("Пришлите, что есть: скрины");
  });
});

describe("elapsedMinutes", () => {
  it("counts whole minutes of the current stage", () => {
    expect(elapsedMinutes(undefined)).toBe(0);
    expect(elapsedMinutes({ gate: "2", title: "", attempt: 1, since: 0 }, 185_000)).toBe(3);
  });
});
