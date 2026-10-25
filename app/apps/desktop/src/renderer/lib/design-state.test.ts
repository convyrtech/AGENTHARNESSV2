import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DesignEvent } from "@zeno/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  editAnswer,
  editOptions,
  DESIGN_STEPS,
  EMPTY_DESIGN_VIEW,
  elapsedMinutes,
  harnessNow,
  isLetterKey,
  optionLabel,
  foldDesign,
  openQuestion,
  ownerText,
  answerText,
  RECOMMEND_ANSWER,
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

  it("turn 1: progress while running, then a two-question card", () => {
    let v = EMPTY_DESIGN_VIEW;
    const [user, stage, tool] = turns[0]!;
    v = reduceDesign(v, user!, 1000);
    expect(v.running).toBe(true);
    v = reduceDesign(v, stage!, 1000);
    // times come from the harness clock (the event's `t`), not the moment it arrived
    const at = (stage!.t ?? 0) * 1000;
    expect(v.stage).toMatchObject({ gate: "0", attempt: 1, since: at, stepSince: at });
    v = reduceDesign(v, tool!);
    expect(v.ticker).toEqual(["bash flow.py --page design/landing"]);
    for (const e of turns[0]!.slice(3)) v = reduceDesign(v, e);
    expect(v.running).toBe(false);
    expect(v.stage).toBeUndefined();
    expect(v.items.map((i) => i.kind)).toEqual(["user", "owner"]);
    const q = openQuestion(v)!;
    expect(q.options.map((g) => g.q)).toEqual([
      "Для кого страница?",
      "Что главное на первом экране?",
    ]);
    expect(ownerText(q.text, q.files, q.options)).toBe(
      "Два вопроса, чтобы начать.\nРекомендую 1А 2А. И пришлите, что есть: логотип, скрины, ссылку на сайт.",
    );
  });

  it("turn 2 answers the first card and opens a choice with a picture", () => {
    const v = foldDesign([...turns[0]!, ...turns[1]!], false);
    expect(v.items.map((i) => i.kind)).toEqual(["user", "owner", "user", "owner"]);
    const first = v.items[1]!;
    expect(first.kind === "owner" && first.answered).toBe(true);
    const q = openQuestion(v)!;
    expect(q.options[0]!.options.map((o) => o.key)).toEqual(["A", "B", "C"]);
    expect(q.files[0]!.path).toBe("design/landing/00-moods.png");
  });

  it("turn 3 runs out of stages for the turn (continue), turn 4 is stuck", () => {
    const three = foldDesign(turns.slice(0, 3).flat(), false);
    expect(three.items.at(-1)?.kind).toBe("paused");
    const v = foldDesign(turns.slice(0, 4).flat(), false);
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

  it("a turn cut off by quitting the app offers «continue» once", () => {
    const cut: DesignEvent[] = [
      { ev: "user", text: "Сделай лендинг", files: [] },
      { ev: "stage", gate: "1", title: "Кандидаты", model: "m", attempt: 1 },
      { ev: "tool", name: "bash", brief: "python3 -I harness/moves.py candidates" },
    ];
    const v = foldDesign(cut, false);
    expect(v.running).toBe(false);
    expect(v.items.map((i) => i.kind)).toEqual(["user", "interrupted"]);
    // continuing: the next run's events follow; the old item stays history, no second «continue»
    const next = foldDesign(
      [...cut, { ev: "stage", gate: "1", title: "", model: "m", attempt: 2 }],
      true,
    );
    expect(next.items.filter((i) => i.kind === "interrupted")).toHaveLength(0);
    // a turn that already asked the owner before the app closed is not «interrupted»
    const asked = foldDesign([...cut, { ev: "owner", text: "?", files: [], options: [] }], false);
    expect(asked.items.at(-1)?.kind).toBe("owner");
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
    expect(ownerText(text, files, [{ q: "", options: [{ key: "A", label: "Тёплое утро" }] }])).toBe(
      "Собрал три настроения из вашего логотипа.\nРекомендую A. Какое берём?",
    );
    expect(ownerText("Пришлите, что есть: скрины", [], [])).toBe("Пришлите, что есть: скрины");
  });
});

describe("answerText", () => {
  const two = [
    {
      q: "Для кого?",
      options: [
        { key: "А", label: "Гости" },
        { key: "Б", label: "Опт" },
      ],
    },
    {
      q: "Что главное?",
      options: [
        { key: "А", label: "Меню" },
        { key: "Б", label: "Адрес" },
      ],
    },
  ];
  it("needs a pick per question and joins them as run.py reads them", () => {
    expect(answerText(two, { 0: "А" })).toBeUndefined();
    expect(answerText(two, { 0: "А", 1: "Б" })).toBe("1А 2Б");
    expect(answerText([two[0]!], { 0: "Б" })).toBe("Б. Опт");
    expect(answerText([], {})).toBeUndefined();
  });

  it("«как рекомендуешь» is the exact phrase the engine expects", () => {
    expect(RECOMMEND_ANSWER).toBe("как рекомендуешь");
  });
});

describe("elapsedMinutes", () => {
  it("counts whole minutes of the current stage", () => {
    expect(elapsedMinutes(undefined)).toBe(0);
    expect(
      elapsedMinutes({ gate: "2", title: "", attempt: 1, since: 0, stepSince: 0 }, 185_000),
    ).toBe(3);
  });
});

describe("step time on the harness clock", () => {
  // a fixed «now» at the epoch: the small `t`s below are then fresh, not a stale clock
  const at0 = (v: Parameters<typeof reduceDesign>[0], e: Parameters<typeof reduceDesign>[1]) =>
    reduceDesign(v, e, 0);
  const stageAt = (gate: string, t: number) =>
    ({ ev: "stage", gate, title: gate, model: "m", attempt: 1, t }) as const;

  it("a retried gate or the next gate of the same step keeps the step's start", () => {
    let v = at0(EMPTY_DESIGN_VIEW, stageAt("6", 100));
    v = at0(v, stageAt("7", 400));
    v = at0(v, stageAt("7", 900));
    expect(v.stage).toMatchObject({ gate: "7", since: 900_000, stepSince: 100_000 });
    expect(elapsedMinutes(v.stage, 100_000 + 12 * 60_000)).toBe(12);
    v = at0(v, stageAt("8", 1000));
    expect(v.stage?.stepSince).toBe(1_000_000);
  });

  it("tracks the latest event and the harness's own words for the action", () => {
    let v = at0(EMPTY_DESIGN_VIEW, stageAt("7", 100));
    v = at0(v, { ev: "tool", name: "bash", brief: "python3 -c …", t: 160 });
    expect(v.lastEventAt).toBe(160_000);
    expect(v.doing).toBeUndefined();
    v = at0(v, {
      ev: "tool",
      name: "bash",
      brief: "gate.py",
      doing: "Проверяю страницу на телефоне",
      t: 170,
    });
    expect(v.doing).toBe("Проверяю страницу на телефоне");
    expect(harnessNow(v, 100_000)).toBe(170_000);
    expect(harnessNow(v, 200_000)).toBe(200_000);
  });

  it("a stale event clock (an old log, a clock far off) falls back to the arrival time", () => {
    const now = 1_800_000_000_000;
    const v = reduceDesign(EMPTY_DESIGN_VIEW, stageAt("2", now / 1000 - 8 * 3600), now);
    expect(v.stage?.since).toBe(now);
    const ahead = reduceDesign(EMPTY_DESIGN_VIEW, stageAt("2", now / 1000 + 600), now);
    expect(ahead.stage?.since).toBe(now + 600_000);
  });

  it("keeps the last eight tool calls for «Подробности»", () => {
    let v = reduceDesign(EMPTY_DESIGN_VIEW, stageAt("7", 1));
    for (let i = 0; i < 12; i++)
      v = reduceDesign(v, { ev: "tool", name: "read", brief: `f${i}.md` });
    expect(v.ticker).toHaveLength(8);
    expect(v.ticker.at(-1)).toBe("read f11.md");
  });
});

describe("tickerLine", () => {
  it("drops the «cd <workspace> &&» that opens almost every command", () => {
    expect(
      tickerLine("bash", "cd /home/u/run/сайт && grep -n ringHead design/landing/x.html"),
    ).toBe("bash grep -n ringHead design/landing/x.html");
    expect(tickerLine("bash", "cd /w && python3 -I design-pipeline/tools/gate.py --url x")).toBe(
      "bash gate.py --url x",
    );
  });
});

describe("run.py's word options", () => {
  const opt = (key: string, label: string, recommended = false) => ({ key, label, recommended });

  it("sends a word option's key as is, a letter with its label", () => {
    const yesNo = [{ q: "", options: [opt("да", "Да", true), opt("нет", "Нет, поправить")] }];
    expect(answerText(yesNo, { 0: "да" })).toBe("да");
    const screen = [{ q: "", options: [opt("экран с тремя шагами", "Экран с тремя шагами")] }];
    expect(answerText(screen, { 0: "экран с тремя шагами" })).toBe("экран с тремя шагами");
    const abc = [{ q: "", options: [opt("A", "A — прибор и три шага", true), opt("B", "B")] }];
    expect(answerText(abc, { 0: "A" })).toBe("A. прибор и три шага");
    expect(answerText(abc, { 0: "B" })).toBe("B");
  });

  it("does not repeat the letter in a label, keeps word labels whole", () => {
    expect(optionLabel(opt("A", "A — прибор и три шага"))).toBe("прибор и три шага");
    expect(optionLabel(opt("B", "B"))).toBe("");
    expect(optionLabel(opt("А", "Разработчики и команды"))).toBe("Разработчики и команды");
    expect(optionLabel(opt("смешать", "Смешать"))).toBe("Смешать");
    expect(isLetterKey("A")).toBe(true);
    expect(isLetterKey("Б")).toBe(true);
    expect(isLetterKey("да")).toBe(false);
  });
});

describe("edit answers", () => {
  const opt = (key: string) => ({ key, label: key, recommended: false });
  it("knows run.py's two buttons after an edit", () => {
    expect(editAnswer("edit:keep:3")).toBe("keep");
    expect(editAnswer(" edit:revert:12 ")).toBe("revert");
    expect(editAnswer("edit:keep")).toBeUndefined();
    expect(editAnswer("оставить")).toBeUndefined();
    expect(editOptions([{ q: "", options: [opt("edit:keep:1"), opt("edit:revert:1")] }])).toBe(
      true,
    );
    expect(editOptions([{ q: "", options: [opt("A"), opt("edit:keep:1")] }])).toBe(false);
    expect(editOptions([])).toBe(false);
  });
});
