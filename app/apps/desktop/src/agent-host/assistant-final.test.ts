import { describe, expect, it } from "vite-plus/test";
import { assistantFinalContent } from "./assistant-final.ts";

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
