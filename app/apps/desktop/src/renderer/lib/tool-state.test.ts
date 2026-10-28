// @vitest-environment node
import { describe, expect, it } from "vite-plus/test";
import { TOOL_STALL_MS, toolCallState } from "./tool-state.ts";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();

describe("toolCallState", () => {
  it("is «выполняется» while a fresh call is open", () => {
    const info = toolCallState(
      { toolName: "bash", status: "running", timestamp: at(0), args: { command: "ls" } },
      T0 + 1_200,
    );
    expect(info.state).toBe("running");
    expect(info.live).toBe(true);
    expect(info.elapsedMs).toBe(1_200);
  });

  it("turns to «зависло» after TOOL_STALL_MS and still counts time", () => {
    const item = { toolName: "bash", status: "running" as const, timestamp: at(0) };
    expect(toolCallState(item, T0 + TOOL_STALL_MS - 1).state).toBe("running");
    const stalled = toolCallState(item, T0 + TOOL_STALL_MS);
    expect(stalled.state).toBe("stalled");
    expect(stalled.live).toBe(true);
    expect(stalled.elapsedMs).toBe(TOOL_STALL_MS);
  });

  it("shows «ждёт ответа» for a tool that blocks on a person", () => {
    expect(
      toolCallState(
        { toolName: "ask_user", status: "running", timestamp: at(0) },
        T0 + TOOL_STALL_MS * 3,
      ).state,
    ).toBe("waiting");
    expect(
      toolCallState({ toolName: "request_secret", status: "running", timestamp: at(0) }, T0).state,
    ).toBe("waiting");
  });

  it("reads the declared timeout from the args", () => {
    const info = toolCallState(
      { toolName: "bash", status: "running", timestamp: at(0), args: { command: "x", timeout: 5 } },
      T0,
    );
    expect(info.timeoutSec).toBe(5);
    expect(
      toolCallState({ toolName: "bash", status: "running", timestamp: at(0), args: {} }, T0)
        .timeoutSec,
    ).toBeUndefined();
  });

  it("separates timeout, cancel, plain error and success from the output text", () => {
    const done = (status: "completed" | "error", output: string) =>
      toolCallState(
        { toolName: "bash", status, timestamp: at(0), endedAt: at(2_000), output },
        T0 + 5_000,
      ).state;

    expect(done("error", "Command timed out after 5 seconds")).toBe("timeout");
    expect(done("error", "[таймаут · остановлен по таймауту]")).toBe("timeout");
    expect(done("error", "Command aborted")).toBe("aborted");
    expect(done("error", "Command aborted\n\n[exit 1 · 2.0 с]")).toBe("aborted");
    expect(done("error", "bash: nope: command not found")).toBe("error");
    expect(done("completed", "hello")).toBe("completed");
  });

  it("uses the measured span, not the wall clock, once the call has ended", () => {
    const info = toolCallState(
      { toolName: "bash", status: "completed", timestamp: at(0), endedAt: at(1_500) },
      T0 + 60_000,
    );
    expect(info.elapsedMs).toBe(1_500);
    expect(info.live).toBe(false);
  });

  it("survives a missing or broken timestamp", () => {
    expect(toolCallState({ toolName: "bash", status: "running" }, T0)).toEqual({
      state: "running",
      elapsedMs: undefined,
      live: true,
      timeoutSec: undefined,
    });
    expect(
      toolCallState({ toolName: "bash", status: "running", timestamp: "not a date" }, T0).elapsedMs,
    ).toBeUndefined();
  });
});
