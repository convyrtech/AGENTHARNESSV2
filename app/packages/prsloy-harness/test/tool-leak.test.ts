import { describe, expect, it } from "vite-plus/test";
import {
  cleanLeakedMessage,
  detectToolLeak,
  installToolLeak,
  MAX_LEAK_RETRIES,
  stripToolMarkup,
  TOOL_LEAK_GAVE_UP,
  TOOL_LEAK_NOTE,
} from "../src/tool-leak.ts";
import { detectPseudoToolCall } from "../src/loop-detector.ts";
import { MockPi } from "./mock-pi.ts";
import { LEAK_TEXT, LEAK_THINKING } from "./tool-leak-fixtures.ts";

describe("tool markup leak: patterns", () => {
  it.each([
    ["DeepSeek V4 DSML, with a space", "…for a resize handler.</｜DSML｜ parameter>"],
    ["DeepSeek V4 DSML, no space", "</｜DSML｜invoke>"],
    ["DeepSeek V4 DSML, space after the bar", "<｜ DSML ｜calls>"],
    ["DeepSeek V3 calls begin", "<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function"],
    ["DeepSeek V3 call begin", "x <｜tool▁call▁begin｜> y"],
    ["DeepSeek V3 sep", "function<｜tool▁sep｜>bash"],
    ["Qwen/Hermes open", '<tool_call>{"name":"bash"}'],
    ["Qwen/Hermes close", "done</tool_call>"],
    ["Kimi call begin", "<|tool_call_begin|>functions.bash:0"],
    ["Kimi section begin", "<|tool_calls_section_begin|>"],
  ])("%s", (_name, text) => {
    expect(detectToolLeak(text, "")).toBe("markup");
  });

  it("text == thinking and longer than 1000 characters", () => {
    const long = "Сначала проверю файл. ".repeat(60);
    expect(detectToolLeak(long, `  ${long}\n`)).toBe("duplicate-thinking");
    expect(detectToolLeak("Готово.", "Готово.")).toBeUndefined();
    expect(detectToolLeak(long, `${long} и ещё`)).toBeUndefined();
  });

  it("the real DeepSeek answer from the A/B; ordinary answers and explanations in code are not leaks", () => {
    expect(detectToolLeak(LEAK_TEXT, LEAK_THINKING)).toBe("markup");
    expect(
      detectToolLeak("Готово: страница собрана, откройте index.html.", "думаю"),
    ).toBeUndefined();
    expect(detectToolLeak("Формат Hermes: `<tool_call>{…}</tool_call>`", "")).toBeUndefined();
  });

  it("strips markup lines and keeps the rest", () => {
    expect(stripToolMarkup("Готово.\n</｜DSML｜ invoke>\n</｜DSML｜ calls>")).toBe("Готово.");
  });

  it("context for the model: the duplicated reasoning goes, thinking stays", () => {
    const clean = cleanLeakedMessage({
      role: "assistant",
      stopReason: "stop",
      content: [
        { type: "thinking", thinking: LEAK_THINKING },
        { type: "text", text: LEAK_TEXT },
      ],
    });
    expect(clean?.content).toEqual([{ type: "thinking", thinking: LEAK_THINKING }]);
    expect(
      cleanLeakedMessage({ role: "assistant", content: [{ type: "text", text: "Готово." }] }),
    ).toBeUndefined();
  });

  it("the loop detector leaves these to tool-leak (no double nudge)", () => {
    // Сам детектор псевдовызова такие строки видит — поэтому turn_end явно уступает их tool-leak.
    expect(detectPseudoToolCall("<｜tool▁calls▁begin｜>", [])).toBeDefined();
  });
});

describe("tool markup leak: the turn does not end", () => {
  function setup() {
    const pi = new MockPi();
    installToolLeak(pi.api);
    const leak = () =>
      pi.assistantMessage({
        stopReason: "stop",
        content: [
          { type: "thinking", thinking: LEAK_THINKING },
          { type: "text", text: LEAK_TEXT },
        ],
      });
    const settle = (outcome = "completed") => pi.boundary("agent_before_settle", { outcome });
    return { pi, leak, settle };
  }

  it("push back with the exact line and a continuation", async () => {
    const { pi, leak, settle } = setup();
    await pi.userPrompt();
    await leak();
    const out = await settle();
    expect(out.continue).toBe(true);
    expect(out.entries).toEqual([
      {
        type: "custom_message",
        customType: "prsloy-harness.tool-leak",
        content: TOOL_LEAK_NOTE,
        display: false,
      },
    ]);
    expect(TOOL_LEAK_NOTE).toBe(
      "Твой последний вызов инструмента не дошёл: он пришёл текстом. Повтори его обычным вызовом инструмента, без рассуждений в ответе.",
    );
  });

  it("own limit of 2 per user message, then the human line and the turn ends", async () => {
    const { pi, leak, settle } = setup();
    await pi.userPrompt();
    for (let i = 0; i < MAX_LEAK_RETRIES; i++) {
      await leak();
      expect((await settle()).continue).toBe(true);
    }
    await leak();
    expect(await settle()).toEqual({ entries: [], continue: false });
    expect(pi.sent.map((m) => m.content)).toEqual([TOOL_LEAK_GAVE_UP]);
    expect(TOOL_LEAK_GAVE_UP).toBe(
      "Модель сбилась, нажмите «Повторить» или переключитесь на «Качественнее».",
    );
    await leak();
    expect((await settle()).continue).toBe(false);
    // Новое сообщение — новый счёт.
    await pi.userPrompt("ещё");
    await leak();
    expect((await settle()).continue).toBe(true);
  });

  it("silent on a normal answer, a tool call, a user stop", async () => {
    const { pi, settle } = setup();
    await pi.userPrompt();
    await pi.assistantMessage({ content: [{ type: "text", text: "Готово." }] });
    expect((await settle()).continue).toBe(false);
    await pi.assistantMessage({
      content: [
        { type: "text", text: "</｜DSML｜ invoke>" },
        { type: "toolCall", id: "1", name: "bash", arguments: {} },
      ],
    });
    expect((await settle()).continue).toBe(false);
    await pi.assistantMessage({ content: [{ type: "text", text: LEAK_TEXT }] });
    expect((await settle("aborted")).continue).toBe(false);
  });

  it("context hook cuts the leak out of what the model sees", async () => {
    const { pi } = setup();
    const [result] = (await pi.emit("context", {
      messages: [
        { role: "user", content: "сделай" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: LEAK_THINKING },
            { type: "text", text: LEAK_TEXT },
          ],
        },
      ],
    })) as [{ messages: { role: string; content: unknown }[] }];
    expect(JSON.stringify(result.messages)).not.toContain("DSML");
    expect(result.messages[1]?.content).toEqual([{ type: "thinking", thinking: LEAK_THINKING }]);
  });
});
