import { describe, expect, it } from "vite-plus/test";
import {
  createComputerUseState,
  installComputerUseGuard,
  snapshotIdFor,
  validateComputerUseTarget,
} from "../src/computer-use.ts";
import { MockPi } from "./mock-pi.ts";
import { createPrsloyHarness } from "../src/index.ts";

describe("computer-use safety contract", () => {
  it("generic harness computer-use opt-in never exposes unguarded Munim actions", async () => {
    const pi = new MockPi();
    createPrsloyHarness({ computerUse: true })(pi.api);
    await pi.userPrompt();
    expect(pi.tools.has("munim_type_text")).toBe(true);
    expect(await pi.toolCall("mcp__munimComputerUse__click", { element_id: "e1" })).toMatchObject({
      block: true,
    });
  });
  it("does not select Munim processes reported with multiple windows", async () => {
    const pi = new MockPi();
    installComputerUseGuard(pi.api);
    await pi.userPrompt();
    await pi.call("mcp__munimComputerUse__list_apps", {}, "Fixture  [fixture]  pid=42 windows=2");
    expect(await pi.toolCall("mcp__munimComputerUse__get_app_state", { app: "42" })).toMatchObject({
      block: true,
    });
  });
  it("rejects duplicate PID rows and conflicting window counts", async () => {
    const pi = new MockPi();
    installComputerUseGuard(pi.api);
    await pi.userPrompt();
    await pi.call(
      "mcp__munimComputerUse__list_apps",
      {},
      "One  [one]  pid=42 windows=1\nTwo  [two]  pid=42 windows=1\nThree  [three]  pid=43 windows=1 windows=2",
    );
    expect(await pi.toolCall("mcp__munimComputerUse__get_app_state", { app: "42" })).toMatchObject({
      block: true,
    });
    expect(await pi.toolCall("mcp__munimComputerUse__get_app_state", { app: "43" })).toMatchObject({
      block: true,
    });
  });
  it("uses Munim's real schema, consumes observations and rejects unguarded tools", async () => {
    const pi = new MockPi();
    installComputerUseGuard(pi.api);
    await pi.userPrompt();
    expect(await pi.toolCall("mcp__munimComputerUse__press_key", { key: "Enter" })).toMatchObject({
      block: true,
    });
    await pi.call(
      "mcp__munimComputerUse__list_apps",
      {},
      'Fixture  [fixture]  pid=42  windows=1 window="pid=999"',
    );
    expect(await pi.toolCall("mcp__munimComputerUse__get_app_state", { app: "999" })).toMatchObject(
      { block: true },
    );
    expect(await pi.toolCall("mcp__munimComputerUse__get_app_state", { app: "43" })).toMatchObject({
      block: true,
    });
    await pi.call(
      "mcp__munimComputerUse__get_app_state",
      { app: "42" },
      "42 (pid 42), 1 window(s)\n[e1] Edit\n[e2] Button",
    );
    expect(await pi.toolCall("mcp__munimComputerUse__click", {})).toMatchObject({ block: true });
    expect(await pi.toolCall("mcp__munimComputerUse__click", { element_id: "e999" })).toMatchObject(
      { block: true },
    );
    expect(await pi.toolCall("mcp__munimComputerUse__click", { element_id: "e2" })).toBeUndefined();
    expect(await pi.toolCall("mcp__munimComputerUse__click", { element_id: "e2" })).toMatchObject({
      block: true,
    });
  });

  it("does not treat an error as an observation and respects Pi settled cancellation", async () => {
    const pi = new MockPi();
    installComputerUseGuard(pi.api);
    await pi.userPrompt();
    await pi.call("mcp__munimComputerUse__list_apps", {}, "Fixture  [fixture]  pid=42 windows=1");
    await pi.call(
      "mcp__munimComputerUse__get_app_state",
      { app: "42" },
      "42 (pid 42) [e1] error",
      true,
    );
    expect(await pi.toolCall("mcp__munimComputerUse__click", { element_id: "e1" })).toMatchObject({
      block: true,
    });
    await pi.emit("agent_settled", { aborted: true });
    expect(await pi.toolCall("mcp__munimComputerUse__get_app_state", { app: "42" })).toMatchObject({
      block: true,
    });
  });
  it("does not restore a superseded observation and keeps the selected PID", async () => {
    const pi = new MockPi();
    installComputerUseGuard(pi.api);
    await pi.userPrompt();
    await pi.call(
      "mcp__munimComputerUse__list_apps",
      {},
      "First  [first]  pid=42 windows=1\nSecond  [second]  pid=43 windows=1",
    );
    await pi.toolCall("mcp__munimComputerUse__get_app_state", { app: "42" }, "old");
    await pi.toolCall("mcp__munimComputerUse__get_app_state", { app: "42" }, "new");
    await pi.toolResult({
      toolName: "mcp__munimComputerUse__get_app_state",
      toolCallId: "old",
      text: "42 (pid 42) [e1] old",
    });
    expect(await pi.toolCall("mcp__munimComputerUse__click", { element_id: "e1" })).toMatchObject({
      block: true,
    });
    await pi.toolResult({
      toolName: "mcp__munimComputerUse__get_app_state",
      toolCallId: "new",
      text: "42 (pid 42) [e2] new",
    });
    expect(await pi.toolCall("mcp__munimComputerUse__get_app_state", { app: "43" })).toMatchObject({
      block: true,
    });
    expect(
      await pi.toolCall("mcp__munimComputerUse__click", { element_id: "e2", x: 1, y: 1 }),
    ).toMatchObject({ block: true });
    expect(await pi.toolCall("mcp__munimComputerUse__click", { element_id: "e2" })).toBeUndefined();
  });
  it("preserves MCP screenshot image blocks and denies another PID", async () => {
    const pi = new MockPi();
    installComputerUseGuard(pi.api);
    await pi.userPrompt();
    await pi.call("mcp__munimComputerUse__list_apps", {}, "Fixture  [fixture]  pid=42 windows=1");
    await pi.call("mcp__munimComputerUse__get_app_state", { app: "42" }, "42 (pid 42) [e1] Edit");
    expect(await pi.toolCall("mcp__munimComputerUse__screenshot", { app: "43" })).toMatchObject({
      block: true,
    });
    expect(
      await pi.toolCall("mcp__munimComputerUse__screenshot", { app: "42" }, "shot"),
    ).toBeUndefined();
    const result = await pi.emit("tool_result", {
      toolName: "mcp__munimComputerUse__screenshot",
      toolCallId: "shot",
      content: [{ type: "image", data: "AQID", mimeType: "image/png" }],
      isError: false,
    });
    expect(result).toEqual([undefined]);
  });
  it("invalidates the observation before waiting", async () => {
    const pi = new MockPi();
    installComputerUseGuard(pi.api);
    await pi.userPrompt();
    await pi.call("mcp__munimComputerUse__list_apps", {}, "Fixture  [fixture]  pid=42 windows=1");
    await pi.call("mcp__munimComputerUse__get_app_state", { app: "42" }, "42 (pid 42) [e1] Edit");
    expect(await pi.toolCall("mcp__munimComputerUse__wait", { seconds: 1 })).toBeUndefined();
    expect(await pi.toolCall("mcp__munimComputerUse__click", { element_id: "e1" })).toMatchObject({
      block: true,
    });
  });
  it("requires observation before actions", () => {
    expect(
      validateComputerUseTarget(createComputerUseState(), { targetPid: 1, snapshotId: "1:a" }),
    ).toMatch(/Сначала/u);
  });

  it("rejects a different PID and stale snapshot", () => {
    const state = createComputerUseState();
    state.targetPid = 42;
    state.snapshotId = snapshotIdFor(42, "7");
    expect(
      validateComputerUseTarget(state, { targetPid: 43, snapshotId: state.snapshotId }),
    ).toMatch(/PID/u);
    expect(
      validateComputerUseTarget(state, { targetPid: 42, snapshotId: snapshotIdFor(42, "6") }),
    ).toMatch(/устарел/u);
  });

  it("blocks every action after abort", () => {
    const state = createComputerUseState();
    state.targetPid = 42;
    state.snapshotId = snapshotIdFor(42, "7");
    state.aborted = true;
    expect(
      validateComputerUseTarget(state, { targetPid: 42, snapshotId: state.snapshotId }),
    ).toMatch(/остановлен/u);
  });

  it("guards the real MCP tool calls and records a fresh result snapshot", async () => {
    const pi = new MockPi();
    installComputerUseGuard(pi.api);
    await pi.toolCall("mcp__munimComputerUse__list_apps", {}, "list-1");
    await pi.toolResult({
      toolName: "mcp__munimComputerUse__list_apps",
      toolCallId: "list-1",
      details: { targetPid: 42 },
      text: "Test Window  [test]  pid=42 windows=1",
    });
    await pi.toolCall("mcp__munimComputerUse__get_app_state", { targetPid: 42 }, "state-1");
    await pi.toolResult({
      toolName: "mcp__munimComputerUse__get_app_state",
      toolCallId: "state-1",
      details: { targetPid: 42 },
      text: "42 (pid 42), 1 window(s) [e1] field; [e2] button",
    });
    expect(
      await pi.toolCall("mcp__munimComputerUse__click", {
        targetPid: 42,
        snapshotId: "42:stale",
        elementId: "e2",
      }),
    ).toMatchObject({
      block: true,
    });
    expect(
      await pi.toolCall("mcp__munimComputerUse__click", {
        targetPid: 42,
        elementId: "e2",
      }),
    ).toBeUndefined();
    expect(pi.ctx.ui).toBeDefined();
  });

  it("allows a new user turn after an aborted turn", async () => {
    const pi = new MockPi();
    installComputerUseGuard(pi.api);
    await pi.emit("agent_settled", { aborted: true });
    expect(
      await pi.toolCall("mcp__munimComputerUse__click", {
        targetPid: 1,
        snapshotId: "1:1",
        elementId: "e1",
      }),
    ).toMatchObject({
      block: true,
    });
    await pi.userPrompt("новая задача");
    await pi.call("mcp__munimComputerUse__list_apps", {}, "Test  [test]  pid=1 windows=1");
    await pi.toolCall("mcp__munimComputerUse__get_app_state", { targetPid: 1 }, "state-new");
    await pi.toolResult({
      toolName: "mcp__munimComputerUse__get_app_state",
      toolCallId: "state-new",
      details: { targetPid: 1 },
      text: "1 (pid 1), 1 window(s) [e1] field",
    });
    expect(
      await pi.toolCall("mcp__munimComputerUse__click", { targetPid: 1, elementId: "e1" }),
    ).toBeUndefined();
  });

  it("ignores a late result from the previous user turn", async () => {
    const pi = new MockPi();
    installComputerUseGuard(pi.api);
    await pi.userPrompt("старый ход");
    await pi.toolCall("mcp__munimComputerUse__get_app_state", { targetPid: 11 }, "old-state");
    await pi.userPrompt("новый ход");
    await pi.toolResult({
      toolName: "mcp__munimComputerUse__get_app_state",
      toolCallId: "old-state",
      details: { targetPid: 11 },
      text: "e1 old",
    });
    expect(
      await pi.toolCall("mcp__munimComputerUse__click", { targetPid: 11, elementId: "e1" }),
    ).toMatchObject({ block: true });
  });
});
