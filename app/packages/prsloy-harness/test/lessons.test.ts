import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import {
  BUNDLED_LESSONS,
  inTrial,
  installLessons,
  LESSONS_HEADER,
  LESSONS_MAX_CHARS,
  LessonCounters,
  lessonsSection,
  lessonTip,
  loadLessons,
  pickTip,
  TIP_PREFIX,
  type Lesson,
} from "../src/lessons.ts";
import { fitPromptBudget, MEMORY_LESSONS_MAX_CHARS } from "../src/prompt-budget.ts";
import { MockPi } from "./mock-pi.ts";

const FIXTURE = new URL("./fixtures/lessons/code.json", import.meta.url).pathname;
const root = mkdtempSync(join(tmpdir(), "prsloy-lessons-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const lesson = (id: string, text: string, extra: Partial<Lesson> = {}): Lesson => ({
  id,
  surface: "code",
  models: ["*"],
  mode: "always",
  text,
  status: "active",
  ...extra,
});

describe("lessons: the shipped file", () => {
  it("only §8.2 seeds for «Код» (active/candidate) — one, already delivered by prsloy_casual_user", () => {
    expect(BUNDLED_LESSONS.map((l) => [l.id, l.status, l.delivery])).toEqual([
      ["L-c-casual-no-commands", "active", "section:prsloy_casual_user"],
    ]);
    // Уже доставлен постоянным разделом — в prsloy_lessons не дублируется.
    expect(lessonsSection(BUNDLED_LESSONS, "deepseek-v4.1-flash", "s").text).toBe("");
  });
});

describe("lessons: the prompt section", () => {
  const all = loadLessons(FIXTURE);

  it("per model family, active only, no candidates / delivered / design", () => {
    const ds = lessonsSection(all, "deepseek-v4.1-flash", "s");
    expect(ds.ids).toEqual(["T-always-ds", "T-always-all"]);
    expect(ds.text).toBe(
      `${LESSONS_HEADER}\n- Run the project's own test before saying done.\n- Keep answers to the user short and in Russian.`,
    );
    expect(lessonsSection(all, "kimi-k3.1-pro", "s").ids).toEqual([
      "T-always-all",
      "T-always-kimi",
    ]);
    expect(lessonsSection(all, "deepseek-v4.1-flash", "s", new Set(["T-always-ds"])).ids).toEqual([
      "T-always-all",
    ]);
  });

  it("≤5 lessons and ≤800 characters", () => {
    const many = Array.from({ length: 9 }, (_, i) => lesson(`m${i}`, `Lesson number ${i}.`));
    expect(lessonsSection(many, "x", "s").ids).toHaveLength(5);
    const long = Array.from({ length: 5 }, (_, i) => lesson(`l${i}`, "x".repeat(300)));
    const section = lessonsSection(long, "x", "s");
    expect(section.text.length).toBeLessThanOrEqual(LESSONS_MAX_CHARS);
    expect(section.ids).toHaveLength(2);
  });

  it("trial lessons show in about 15% of sessions, the same session always the same", () => {
    const shown = Array.from({ length: 2000 }, (_, i) => inTrial(`session-${i}`, "T")).filter(
      Boolean,
    ).length;
    expect(shown / 2000).toBeGreaterThan(0.1);
    expect(shown / 2000).toBeLessThan(0.2);
    expect(inTrial("abc", "T")).toBe(inTrial("abc", "T"));
  });
});

describe("lessons: situational tips and counters", () => {
  const all = loadLessons(FIXTURE);

  it("a tip matches the event kind and a signature mask", () => {
    expect(
      pickTip(all, "deepseek-v4.1-flash", "s", { kind: "loop.warn", sig: "bash:ls" })?.id,
    ).toBe("T-tip-ls");
    expect(
      pickTip(all, "deepseek-v4.1-flash", "s", { kind: "loop.warn", sig: "bash:npm test" }),
    ).toBeUndefined();
    expect(
      pickTip(all, "deepseek-v4.1-flash", "s", { kind: "gate.red", sig: "bash:ls" }),
    ).toBeUndefined();
  });

  it("retired automatically when hurt ≥ helped after ≥10 shows", () => {
    const c = new LessonCounters(join(root, "c1.json"));
    for (let i = 0; i < 9; i++) c.bump("x", "shown");
    c.bump("x", "hurt");
    expect(c.retired("x")).toBe(false);
    c.bump("x", "shown");
    expect(c.retired("x")).toBe(true);
    c.save();
    expect(new LessonCounters(join(root, "c1.json")).get("x")).toEqual({
      shown: 10,
      helped: 0,
      hurt: 1,
    });
  });

  it("the prompt budget for memory + lessons is ≤3 800 characters", () => {
    const memory = `Header\n${Array.from({ length: 40 }, (_, i) => `- memory ${i} ${"m".repeat(80)}`).join("\n")}`;
    const lessons = `${LESSONS_HEADER}\n- ${"l".repeat(700)}`;
    const fitted = fitPromptBudget({ memory, lessons });
    expect(fitted.memory.length + fitted.lessons.length).toBeLessThanOrEqual(
      MEMORY_LESSONS_MAX_CHARS,
    );
    expect(fitPromptBudget({ memory: "", lessons })).toEqual({ memory: "", lessons });
  });
});

describe("lessons: frozen per session (cache)", () => {
  function setup(flags: Record<string, unknown> = {}, lessonsPath = FIXTURE) {
    const settingsPath = join(root, `flags-${Math.random()}.json`);
    writeFileSync(settingsPath, JSON.stringify(flags));
    const pi = new MockPi(root);
    (pi.ctx as { model?: unknown }).model = { id: "deepseek-v4.1-flash-1017" };
    installLessons(pi.api, {
      lessonsPath,
      settingsPath,
      countersPath: join(root, `c-${Math.random()}.json`),
    });
    const sections = async () => {
      const event = {
        messageType: "user",
        prompt: "x",
        systemPrompt: "",
        systemPromptOptions: { sections: {} as Record<string, string> },
      };
      for (const h of pi.handlers.get("before_agent_start") ?? [])
        await h({ type: "before_agent_start", ...event }, pi.ctx);
      return event.systemPromptOptions.sections;
    };
    return { pi, sections, settingsPath };
  }

  it("the same section byte for byte on every turn, even if the flags change mid-session", async () => {
    const { pi, sections, settingsPath } = setup();
    await pi.emit("session_start", {});
    const first = (await sections()).prsloy_lessons;
    expect(first).toContain("Run the project's own test");
    writeFileSync(settingsPath, JSON.stringify({ lessons: false }));
    expect((await sections()).prsloy_lessons).toBe(first);
    // Смена модели — новый снимок (флаги читаются заново).
    writeFileSync(settingsPath, JSON.stringify({}));
    (pi.ctx as { model?: unknown }).model = { id: "kimi-k3.1-pro" };
    await pi.emit("model_select", {});
    expect((await sections()).prsloy_lessons).toContain("Kimi-only note.");
  });

  it("flag lessons:false — no section and no tips", async () => {
    const { pi, sections } = setup({ lessons: false });
    await pi.emit("session_start", {});
    expect((await sections()).prsloy_lessons).toBeUndefined();
    expect(lessonTip(pi.ctx, { kind: "loop.warn", sig: "bash:ls" })).toEqual({ text: "", ids: [] });
  });

  it("disabledLessons switches a single tip off", async () => {
    const { pi } = setup({ disabledLessons: ["T-tip-ls"] });
    await pi.emit("session_start", {});
    expect(lessonTip(pi.ctx, { kind: "loop.warn", sig: "bash:ls" }).text).toBe("");
    const on = setup();
    await on.pi.emit("session_start", {});
    expect(lessonTip(on.pi.ctx, { kind: "loop.warn", sig: "bash:ls" }).text).toBe(
      `\n\n${TIP_PREFIX}Listing the folder again will not change it: read the file you need instead.`,
    );
  });
});
