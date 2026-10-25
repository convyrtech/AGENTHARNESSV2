import { describe, expect, it } from "vite-plus/test";
import {
  detectPseudoToolCall,
  installLoopDetector,
  LENGTH_NOTE,
  PSEUDO_CALL_NOTE,
} from "../src/loop-detector.ts";
import { resolveOptions } from "../src/options.ts";
import { MockPi } from "./mock-pi.ts";

function setup() {
  const pi = new MockPi();
  installLoopDetector(pi.api, resolveOptions());
  return pi;
}

describe("loop detector", () => {
  it("blocks the 3rd identical call with the same result and stops the task at the 5th", async () => {
    const pi = setup();
    await pi.userPrompt();
    const input = { command: "npm test" };
    expect((await pi.call("bash", input, "1 failing")).blocked).toBeUndefined();
    expect((await pi.call("bash", { ...input }, "1 failing")).blocked).toBeUndefined();

    const third = await pi.call("bash", { ...input }, "1 failing");
    expect(third.blocked?.block).toBe(true);
    expect(third.blocked?.reason).toContain(
      "Этот вызов уже был 2 раза с тем же результатом. Сделай другое:",
    );
    expect(third.blocked?.terminate).toBeUndefined();

    const fourth = await pi.call("bash", { ...input }, "1 failing");
    expect(fourth.blocked?.reason).toContain("уже был 3 раза");

    const fifth = await pi.call("bash", { ...input }, "1 failing");
    expect(fifth.blocked?.terminate).toBe(true);
    expect(pi.aborted).toBe(0);
    await pi.call("bash", { ...input }, "1 failing");
    expect(pi.aborted).toBe(1);
  });

  it("treats argument key order as the same call", async () => {
    const pi = setup();
    await pi.call("read", { path: "a.ts", offset: 1 }, "x");
    await pi.call("read", { offset: 1, path: "a.ts" }, "x");
    expect((await pi.call("read", { path: "a.ts", offset: 1 }, "x")).blocked?.block).toBe(true);
  });

  it("does not count a repeat whose result changed (e.g. tests after an edit)", async () => {
    const pi = setup();
    const input = { command: "npm test" };
    await pi.call("bash", input, "2 failing");
    await pi.call("bash", input, "1 failing");
    expect((await pi.call("bash", input, "0 failing")).blocked).toBeUndefined();
    expect((await pi.call("bash", input, "0 failing")).blocked).toBeUndefined();
    expect((await pi.call("bash", input, "0 failing")).blocked?.block).toBe(true);
  });

  it("after a successful edit the same command runs again (checking the fix is not a loop)", async () => {
    const pi = setup();
    const input = { command: "npm test" };
    await pi.call("bash", input, "1 failing");
    await pi.call("bash", input, "1 failing");
    expect((await pi.call("bash", input, "1 failing")).blocked?.block).toBe(true);
    await pi.call("edit", { path: "src/x.ts", edits: [] }, "Edited");
    expect((await pi.call("bash", input, "0 failing")).blocked).toBeUndefined();
    // Неудачная правка файлы не меняет — счёт не сбрасывается.
    const pi2 = setup();
    await pi2.call("bash", input, "1 failing");
    await pi2.call("bash", input, "1 failing");
    await pi2.call("edit", { path: "src/x.ts", edits: [] }, "Could not find", true);
    expect((await pi2.call("bash", input, "1 failing")).blocked?.block).toBe(true);
  });

  it("ignores Pi's unique temp-file path when comparing results", async () => {
    const pi = setup();
    const out = (n: number) =>
      `tail\n\n[Showing lines 1-2000 of 9000. Full output: /tmp/pi-bash-${n}.log]`;
    await pi.call("bash", { command: "make" }, out(1));
    await pi.call("bash", { command: "make" }, out(2));
    expect((await pi.call("bash", { command: "make" }, out(3))).blocked?.block).toBe(true);
  });

  it("keeps entries proposed by other extensions at turn_end", async () => {
    const pi = setup();
    const other = { type: "custom", customType: "host", data: 1 };
    const message = {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "<function=bash>{}</function>" }],
    };
    const result = await pi.boundary("turn_end", { message, toolResults: [], entries: [other] });
    expect(result.entries[0]).toEqual(other);
    expect(result.entries).toHaveLength(2);
  });

  it("different args are different calls", async () => {
    const pi = setup();
    for (let i = 0; i < 6; i++) {
      expect((await pi.call("read", { path: `f${i}.ts` }, "same")).blocked).toBeUndefined();
    }
  });

  it("resets on a new user prompt", async () => {
    const pi = setup();
    await pi.call("bash", { command: "ls" }, "a");
    await pi.call("bash", { command: "ls" }, "a");
    await pi.userPrompt("ещё раз");
    expect((await pi.call("bash", { command: "ls" }, "a")).blocked).toBeUndefined();
  });

  it("asks for a real call when the model wrote a tool call as text", async () => {
    const pi = setup();
    const message = {
      role: "assistant",
      stopReason: "stop",
      content: [
        {
          type: "text",
          // Служебные токены (<tool_call>, DSML, …) — забота tool-leak.ts; здесь — разметка Llama.
          text: 'Сейчас посмотрю.\n<function=bash>{"command": "ls"}</function>',
        },
      ],
    };
    const first = await pi.boundary("turn_end", { message, toolResults: [] });
    expect(first.continue).toBe(true);
    expect(first.entries).toEqual([
      {
        type: "custom_message",
        customType: "prsloy-harness",
        content: PSEUDO_CALL_NOTE,
        display: false,
      },
    ]);
    await pi.boundary("turn_end", { message, toolResults: [] });
    // Не больше двух напоминаний на задачу — иначе сами устроим петлю.
    expect((await pi.boundary("turn_end", { message, toolResults: [] })).continue).toBe(false);
  });

  it("ignores ordinary text and real tool calls", async () => {
    const pi = setup();
    const plain = {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "Готово, файл index.html создан." }],
    };
    expect((await pi.boundary("turn_end", { message: plain, toolResults: [] })).continue).toBe(
      false,
    );
  });

  it("guards against executing calls from a length-truncated response", async () => {
    const pi = setup();
    await pi.assistantMessage({
      stopReason: "length",
      content: [{ type: "toolCall", id: "c1", name: "write", arguments: {} }],
    });
    const blocked = await pi.toolCall("write", { path: "a.html", content: "<div" });
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toContain("length");
    await pi.assistantMessage({ stopReason: "toolUse" });
    expect(await pi.toolCall("write", { path: "a.html", content: "<div></div>" })).toBeUndefined();
  });

  it("hints to write in parts after two length stops with tool calls", async () => {
    const pi = setup();
    const message = {
      role: "assistant",
      stopReason: "length",
      content: [{ type: "toolCall", id: "c", name: "write", arguments: {} }],
    };
    expect((await pi.boundary("turn_end", { message, toolResults: [] })).entries).toEqual([]);
    const second = await pi.boundary("turn_end", { message, toolResults: [] });
    expect(second.entries).toEqual([
      {
        type: "custom_message",
        customType: "prsloy-harness",
        content: LENGTH_NOTE,
        display: false,
      },
    ]);
  });
});

describe("detectPseudoToolCall", () => {
  const tools = ["bash", "read", "edit", "write"];
  it.each([
    ["<tool_call>\n{}\n</tool_call>"],
    ["<function=bash>ls</function>"],
    ['<function_calls><invoke name="bash">'],
    ["<|tool_calls_section_begin|> <|tool_call_begin|>"],
    ["<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>"],
    ['[TOOL_CALLS] [{"name": "bash"}]'],
    ['```json\n{"name": "bash", "arguments": {"command": "ls"}}\n```'],
  ])("detects %s", (text) => {
    expect(detectPseudoToolCall(text, tools)).toBeDefined();
  });

  it("does not flag markers inside code or a fenced example in a long explanation", () => {
    expect(
      detectPseudoToolCall(
        "Qwen оборачивает вызов в `<tool_call>`, а Mistral — в `[TOOL_CALLS]`.",
        tools,
      ),
    ).toBeUndefined();
    const explanation = `${"Вот как выглядит вызов в протоколе Hermes, его парсит сервер. ".repeat(5)}\n\`\`\`\n<tool_call>\n{"name": "bash", "arguments": {}}\n</tool_call>\n\`\`\``;
    expect(detectPseudoToolCall(explanation, tools)).toBeUndefined();
  });

  it("does not flag JSON about unknown tools or prose", () => {
    expect(detectPseudoToolCall('{"name": "Иван", "arguments": 3}', tools)).toBeUndefined();
    expect(detectPseudoToolCall("Запусти bash и посмотри вывод.", tools)).toBeUndefined();
  });
});
