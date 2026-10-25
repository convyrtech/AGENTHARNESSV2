import { describe, expect, it } from "vite-plus/test";
import type { TimelineItem } from "./timeline.ts";
import { projectTimeline } from "./timeline.ts";
import { hideToolLeaks, repeatsThinking, stripToolMarkup } from "./tool-markup.ts";

const THINKING = `${"The page needs a resize handler so the motion stays in sync. ".repeat(20)}Let me check motion.js for a resize handler.`;
const LEAK = `${THINKING}</｜DSML｜ parameter>\n</｜DSML｜ invoke>\n</｜DSML｜ calls>`;

const thinking = (text: string): TimelineItem => ({ id: "t", kind: "thinking", text });
const answer = (text: string): TimelineItem => ({ id: "a", kind: "assistant", text });

describe("tool markup leaks in the chat", () => {
  it("cuts DeepSeek / Qwen / Kimi markup lines, leaves normal text untouched", () => {
    expect(stripToolMarkup("Готово.\n</｜DSML｜ invoke>\n<｜ DSML ｜calls>")).toBe("Готово.");
    expect(stripToolMarkup("a\n<｜tool▁calls▁begin｜>x\n<tool_call>\n<|tool_call_begin|>")).toBe(
      "a",
    );
    const plain = "Готово: откройте index.html.";
    expect(stripToolMarkup(plain)).toBe(plain);
  });

  it("hides an answer that repeats the reasoning (the reasoning row stays)", () => {
    const rows = hideToolLeaks([thinking(THINKING), answer(LEAK)]);
    expect(rows.map((r) => r.kind)).toEqual(["thinking"]);
  });

  it("while streaming, a long prefix of the reasoning is hidden; a short echo is not", () => {
    expect(repeatsThinking(THINKING.slice(0, 300), THINKING)).toBe(true);
    expect(repeatsThinking("The page", "The page needs")).toBe(false);
    expect(repeatsThinking("Готово.", "Готово.")).toBe(false);
  });

  it("a real answer after reasoning stays; markup-only answers vanish", () => {
    const rows = hideToolLeaks([
      thinking(THINKING),
      answer("Сделал: добавил обработчик resize в motion.js."),
      answer("</｜DSML｜ calls>"),
    ]);
    expect(rows.map((r) => (r.kind === "assistant" ? r.text : r.kind))).toEqual([
      "thinking",
      "Сделал: добавил обработчик resize в motion.js.",
    ]);
  });

  it("projectTimeline applies it before hiding thinking rows", () => {
    const rows = projectTimeline({
      history: [],
      liveItems: [thinking(THINKING), answer(LEAK)],
      sessionKey: "",
      hideThinkingBlock: true,
    });
    expect(rows).toEqual([]);
  });
});
