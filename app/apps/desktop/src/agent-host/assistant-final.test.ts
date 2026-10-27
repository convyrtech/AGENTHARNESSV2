import { describe, expect, it } from "vite-plus/test";
import { assistantFinalContent, assistantMessageId } from "./assistant-final.ts";

describe("assistantFinalContent", () => {
  it("joins text blocks and thinking blocks, skipping tool calls", () => {
    expect(
      assistantFinalContent([
        { type: "thinking", thinking: "план" },
        { type: "text", text: "Привет, " },
        { type: "toolCall", id: "1", name: "bash", arguments: {} },
        { type: "text", text: "мир" },
      ]),
    ).toEqual({ text: "Привет, мир", thinking: "план" });
  });

  it("no thinking → no field; odd input → empty text", () => {
    expect(assistantFinalContent([{ type: "text", text: "ok" }])).toEqual({ text: "ok" });
    expect(assistantFinalContent(undefined)).toEqual({ text: "" });
    expect(assistantFinalContent("plain")).toEqual({ text: "plain" });
  });
});

describe("assistantMessageId", () => {
  it("prefers the provider response id, falls back to the request timestamp", () => {
    expect(assistantMessageId({ role: "assistant", responseId: "resp_9", timestamp: 1 })).toBe(
      "r:resp_9",
    );
    expect(assistantMessageId({ role: "assistant", timestamp: 1727 })).toBe("t:1727");
  });

  it("two different assistant messages get two different ids", () => {
    const first = assistantMessageId({ role: "assistant", timestamp: 1727 });
    const second = assistantMessageId({ role: "assistant", timestamp: 1731 });
    expect(first).not.toBe(second);
  });

  it("is undefined for non-assistant messages and odd input", () => {
    expect(assistantMessageId({ role: "user", timestamp: 1 })).toBeUndefined();
    expect(assistantMessageId({ role: "assistant" })).toBeUndefined();
    expect(assistantMessageId(undefined)).toBeUndefined();
  });
});
