import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { Type } from "typebox";
import { createPixRuntime } from "../../agent-runtime/src/index.ts";
import { installCuaComputerUseGuard, type CuaRecoveryGate } from "../src/cua-computer-use.ts";
import { MockPi } from "./mock-pi.ts";
import { ScriptedOpenAiServer } from "./scripted-openai-server.ts";

const token = "s1234abcd:7";
function enable(
  pi: MockPi,
  markdownOnly = false,
  confirmedAction = false,
  recoveryGate?: CuaRecoveryGate,
  onNativeDispatch?: () => void,
  beforeActionResult?: () => Promise<void>,
  withoutRecoveryGate = false,
  onListWindows?: (args: Record<string, unknown>) => void,
  beforeReadResult?: (rawName: string) => Promise<void>,
  onReadResult?: (result: {
    isError: boolean;
    content: unknown[];
    structuredContent?: unknown;
  }) => void,
): () => void {
  let mockActionId = 0;
  const explicitMockGate: CuaRecoveryGate = {
    beginAction: () => `mock-action-${++mockActionId}`,
    recordOutcome: () => {},
    recordAbort: () => {},
  };
  installCuaComputerUseGuard(
    pi.api,
    withoutRecoveryGate ? undefined : (recoveryGate ?? explicitMockGate),
  );
  let abortNextAction = false;
  let activeWrapperId = "";
  const toolContext = {
    ...pi.ctx,
    executeTool: async (
      name: string,
      args: Record<string, unknown>,
      _options?: { signal?: AbortSignal },
    ) => {
      const parentToolCallId = activeWrapperId;
      const toolCallId = `${parentToolCallId}/1`;
      const blocked = await pi.toolCall(name, args, toolCallId, parentToolCallId);
      if (blocked)
        return {
          isError: true,
          result: { content: [{ type: "text", text: blocked.reason ?? "blocked" }] },
        };
      if (name.endsWith("list_windows")) onListWindows?.(args);
      const isRead = name.endsWith("get_window_state");
      const isReadOnly = isRead || name.endsWith("list_windows") || name.endsWith("list_apps");
      if (name.endsWith("click") || name.endsWith("type_text")) onNativeDispatch?.();
      if (name.endsWith("click") || name.endsWith("type_text")) await beforeActionResult?.();
      if (isReadOnly) await beforeReadResult?.(name);
      if (!isRead && (name.endsWith("click") || name.endsWith("type_text")) && abortNextAction) {
        abortNextAction = false;
        await pi.emit("agent_settled", { aborted: true });
        return {
          isError: true,
          result: { content: [{ type: "text", text: "cancelled after native action began" }] },
        };
      }
      const nativeOutput = isRead
        ? markdownOnly
          ? { snapshot_id: "s1234abcd", tree_markdown: '- [7] Edit "Test text"' }
          : { snapshot_id: "s1234abcd", elements: [{ element_token: token }] }
        : confirmedAction && (name.endsWith("click") || name.endsWith("type_text"))
          ? { effect: "confirmed", evidence: [{ kind: "value_readback", detail: "confirmed" }] }
          : {
              windows: [
                { pid: 42, window_id: 100 },
                { pid: 42, window_id: 200 },
              ],
            };
      const image = { type: "image", data: "AQID", mimeType: "image/png" };
      const structuredContent = { content: [], structuredContent: nativeOutput };
      if (isReadOnly) {
        const event: Record<string, unknown> = {
          type: "tool_result",
          toolName: name,
          toolCallId,
          input: args,
          content: isRead
            ? [{ type: "text", text: "snapshot [7]" }, image]
            : [{ type: "text", text: name.endsWith("list_windows") ? "windows" : "apps" }],
          structuredContent,
          isError: false,
        };
        for (const handler of pi.handlers.get("tool_result") ?? []) {
          const replacement = (await handler(event, pi.ctx)) as Record<string, unknown> | undefined;
          if (!replacement) continue;
          if (replacement.content !== undefined) {
            event.content = replacement.content;
            if (replacement.structuredContent === undefined) delete event.structuredContent;
          }
          if (replacement.structuredContent !== undefined)
            event.structuredContent = replacement.structuredContent;
          if (replacement.isError !== undefined) event.isError = replacement.isError;
        }
        const result = {
          isError: event.isError === true,
          content: event.content as unknown[],
          structuredContent: event.structuredContent,
        };
        onReadResult?.(result);
        return { isError: result.isError, result };
      } else {
        await pi.toolResult({ toolName: name, toolCallId, text: "windows", structuredContent });
      }
      return {
        isError: false,
        result: {
          content: isRead
            ? [{ type: "text", text: "snapshot" }, image]
            : [{ type: "text", text: "windows" }],
          structuredContent,
        },
      };
    },
  };
  for (const name of [
    "cua_list_apps",
    "cua_list_windows",
    "cua_get_window_state",
    "cua_click",
    "cua_type_text",
  ]) {
    const tool = pi.tool(name);
    const execute = tool.execute.bind(tool);
    tool.execute = ((
      id: string,
      params: unknown,
      signal: AbortSignal | undefined,
      update: unknown,
      _ctx: unknown,
    ) => {
      activeWrapperId = id;
      return execute(id, params, signal, update as never, toolContext as never).finally(() => {
        activeWrapperId = "";
      });
    }) as typeof tool.execute;
  }
  return () => {
    abortNextAction = true;
  };
}
async function wrapper(
  pi: MockPi,
  name: string,
  params: Record<string, unknown>,
  id: string,
  signal?: AbortSignal,
) {
  try {
    return await pi.tool(name).execute(id, params as never, signal, undefined, pi.ctx as never);
  } catch (error) {
    return { isError: true, text: error instanceof Error ? error.message : String(error) };
  }
}
async function observed(pi: MockPi): Promise<void> {
  await pi.userPrompt();
  await wrapper(pi, "cua_list_windows", {}, "list-wrapper");
  await wrapper(pi, "cua_get_window_state", { pid: 42, window_id: 100 }, "read-wrapper");
}
function deferredStep() {
  let ready!: () => void;
  let release!: () => void;
  return {
    ready: new Promise<void>((resolve) => (ready = resolve)),
    wait: new Promise<void>((resolve) => (release = resolve)),
    markReady: () => ready(),
    release: () => release(),
  };
}
function resultText(value: unknown): string {
  if (!value || typeof value !== "object" || !("content" in value)) return "";
  const content = (value as { content?: unknown }).content;
  return Array.isArray(content)
    ? content
        .filter(
          (item): item is { text: string } =>
            !!item && typeof item === "object" && "text" in item && typeof item.text === "string",
        )
        .map((item) => item.text)
        .join("\n")
    : "";
}

describe("Cua computer-use boundary", () => {
  it.each([
    { raw: "list_apps", wrapperName: "cua_list_apps", params: {}, label: "list_apps" },
    { raw: "list_windows", wrapperName: "cua_list_windows", params: {}, label: "list_windows" },
    {
      raw: "get_window_state",
      wrapperName: "cua_get_window_state",
      params: { pid: 42, window_id: 100 },
      label: "get_window_state with image",
    },
  ])("drops deferred $label result after agent Stop", async ({ raw, wrapperName, params }) => {
    const deferred = deferredStep();
    const seen: { isError: boolean; content: unknown[]; structuredContent?: unknown }[] = [];
    const pi = new MockPi();
    enable(
      pi,
      false,
      false,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      async (name) => {
        if (name.endsWith(raw)) {
          deferred.markReady();
          await deferred.wait;
        }
      },
      (result) => seen.push(result),
    );
    await pi.userPrompt();
    if (raw === "get_window_state")
      await wrapper(pi, "cua_list_windows", {}, "windows-before-stop");
    const pending = wrapper(pi, wrapperName, params, `deferred-${raw}`);
    await deferred.ready;
    await pi.emit("agent_settled", { aborted: true });
    deferred.release();

    const result = await pending;
    expect(result).toMatchObject({ isError: true });
    expect(seen.at(-1)).toMatchObject({ isError: true });
    expect(seen.at(-1)?.content.some((part) => (part as { type?: string }).type === "image")).toBe(
      false,
    );
    expect(seen.at(-1)?.structuredContent).toBeUndefined();

    await pi.userPrompt("after stop");
    const staleAction = await wrapper(
      pi,
      "cua_click",
      { pid: 42, window_id: 100, element_token: token },
      `stale-${raw}`,
    );
    expect(staleAction).toMatchObject({ isError: true });
    if (raw === "get_window_state") {
      const noWindow = await wrapper(
        pi,
        "cua_get_window_state",
        { pid: 42, window_id: 100 },
        "window-not-restored",
      );
      expect(noWindow).toMatchObject({ isError: true });
    }
  });

  it.each([
    { raw: "list_apps", wrapperName: "cua_list_apps", params: {}, label: "list_apps" },
    { raw: "list_windows", wrapperName: "cua_list_windows", params: {}, label: "list_windows" },
    {
      raw: "get_window_state",
      wrapperName: "cua_get_window_state",
      params: { pid: 42, window_id: 100 },
      label: "get_window_state with image",
    },
  ])("drops deferred $label result after signal abort", async ({ raw, wrapperName, params }) => {
    const deferred = deferredStep();
    const seen: { isError: boolean; content: unknown[]; structuredContent?: unknown }[] = [];
    const pi = new MockPi();
    enable(
      pi,
      false,
      false,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      async (name) => {
        if (name.endsWith(raw)) {
          deferred.markReady();
          await deferred.wait;
        }
      },
      (result) => seen.push(result),
    );
    await pi.userPrompt();
    if (raw === "get_window_state")
      await wrapper(pi, "cua_list_windows", {}, `windows-before-signal-${raw}`);
    const controller = new AbortController();
    const pending = wrapper(pi, wrapperName, params, `signal-${raw}`, controller.signal);
    await deferred.ready;
    controller.abort();
    deferred.release();

    const result = await pending;
    expect(result).toMatchObject({ isError: true });
    expect(seen.at(-1)).toMatchObject({ isError: true });
    expect(seen.at(-1)?.content.some((part) => (part as { type?: string }).type === "image")).toBe(
      false,
    );
    expect(seen.at(-1)?.structuredContent).toBeUndefined();
    await pi.userPrompt("after signal abort");
    const staleAction = await wrapper(
      pi,
      "cua_click",
      { pid: 42, window_id: 100, element_token: token },
      `signal-stale-${raw}`,
    );
    expect(staleAction).toMatchObject({ isError: true });
  });

  it("forwards an optional PID filter and rejects invalid filters before native dispatch", async () => {
    const pi = new MockPi();
    const dispatched: Record<string, unknown>[] = [];
    enable(pi, false, false, undefined, undefined, undefined, false, (args) =>
      dispatched.push(args),
    );

    await pi.userPrompt();
    await wrapper(pi, "cua_list_windows", {}, "unfiltered-list");
    expect(dispatched).toEqual([{}]);
    await wrapper(pi, "cua_list_windows", { pid: 4321 }, "filtered-list");
    expect(dispatched).toEqual([{}, { pid: 4321 }]);

    for (const pid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "4321", null]) {
      const before = dispatched.length;
      const result = await wrapper(pi, "cua_list_windows", { pid }, `invalid-list-${String(pid)}`);
      expect(result).toMatchObject({ isError: true });
      expect(dispatched).toHaveLength(before);
    }

    const beforeExtraField = dispatched.length;
    const extraFieldResult = await wrapper(
      pi,
      "cua_list_windows",
      { pid: 4321, unexpected: true },
      "raw-list-extra-field",
    );
    expect(extraFieldResult).toMatchObject({ isError: true });
    expect(dispatched).toHaveLength(beforeExtraField);
  });

  it("does not invalidate a usable snapshot when list_windows input is rejected", async () => {
    const pi = new MockPi();
    let dispatched = 0;
    enable(pi, false, false, undefined, () => dispatched++);
    await observed(pi);

    const rejected = await wrapper(pi, "cua_list_windows", { pid: 0 }, "invalid-list-with-state");
    expect(rejected).toMatchObject({ isError: true });
    const click = await wrapper(
      pi,
      "cua_click",
      { pid: 42, window_id: 100, element_token: token },
      "action-after-invalid-list",
    );
    expect(click.isError).not.toBe(true);
    expect(dispatched).toBe(1);
  });

  it("does not let a deferred list from a previous turn restore window membership", async () => {
    const pi = new MockPi();
    const delayed = deferredStep();
    enable(pi, false, false, undefined, undefined, undefined, false, undefined, async (name) => {
      if (!name.endsWith("list_windows")) return;
      delayed.markReady();
      await delayed.wait;
    });
    await pi.userPrompt("first turn");
    const oldList = wrapper(pi, "cua_list_windows", {}, "old-turn-list");
    await delayed.ready;

    await pi.userPrompt("second turn");
    delayed.release();
    expect(await oldList).toMatchObject({ isError: true });
    expect(
      await wrapper(
        pi,
        "cua_get_window_state",
        { pid: 42, window_id: 100 },
        "no-membership-from-old-turn",
      ),
    ).toMatchObject({ isError: true });
  });

  it.each(["old list responds first", "new list responds first"])(
    "only lets the newest concurrent list_windows call update membership when %s",
    async (order) => {
      const pi = new MockPi();
      const older = deferredStep();
      const newer = deferredStep();
      let lists = 0;
      enable(pi, false, false, undefined, undefined, undefined, false, undefined, async (name) => {
        if (!name.endsWith("list_windows")) return;
        const step = ++lists === 1 ? older : newer;
        step.markReady();
        await step.wait;
      });
      await pi.userPrompt();

      const oldCall = wrapper(pi, "cua_list_windows", {}, "old-list");
      await older.ready;
      const newCall = wrapper(pi, "cua_list_windows", { pid: 42 }, "new-list");
      await newer.ready;

      if (order === "old list responds first") {
        older.release();
        expect(await oldCall).toMatchObject({ isError: true });
        newer.release();
        expect(await newCall).toMatchObject({ isError: false });
      } else {
        newer.release();
        expect(await newCall).toMatchObject({ isError: false });
        older.release();
        expect(await oldCall).toMatchObject({ isError: true });
      }

      // A list result grants membership only; a new snapshot is still required for tokens.
      const read = await wrapper(
        pi,
        "cua_get_window_state",
        { pid: 42, window_id: 100 },
        `fresh-read-${order}`,
      );
      expect(read).toMatchObject({ isError: false });
      const click = await wrapper(
        pi,
        "cua_click",
        { pid: 42, window_id: 100, element_token: token },
        `fresh-click-${order}`,
      );
      expect(click.isError).not.toBe(true);
    },
  );

  it.each(["snapshot responds first", "list responds first"])(
    "drops a snapshot that overlaps a new list when %s and requires a later snapshot",
    async (order) => {
      const pi = new MockPi();
      const delayedRead = deferredStep();
      const delayedList = deferredStep();
      let lists = 0;
      let delayNextRead = false;
      enable(pi, false, false, undefined, undefined, undefined, false, undefined, async (name) => {
        if (name.endsWith("list_windows") && ++lists === 2) {
          delayedList.markReady();
          await delayedList.wait;
        } else if (name.endsWith("get_window_state") && delayNextRead) {
          delayNextRead = false;
          delayedRead.markReady();
          await delayedRead.wait;
        }
      });
      await observed(pi);

      delayNextRead = true;
      const oldRead = wrapper(
        pi,
        "cua_get_window_state",
        { pid: 42, window_id: 100 },
        "overlapping-old-read",
      );
      await delayedRead.ready;
      const newList = wrapper(pi, "cua_list_windows", {}, "overlapping-new-list");
      await delayedList.ready;

      if (order === "snapshot responds first") {
        delayedRead.release();
        const staleSnapshot = await oldRead;
        expect(staleSnapshot).toMatchObject({ isError: true });
        expect(JSON.stringify(staleSnapshot)).not.toContain(token);
        delayedList.release();
        expect(await newList).toMatchObject({ isError: false });
      } else {
        delayedList.release();
        expect(await newList).toMatchObject({ isError: false });
        delayedRead.release();
        const staleSnapshot = await oldRead;
        expect(staleSnapshot).toMatchObject({ isError: true });
        expect(JSON.stringify(staleSnapshot)).not.toContain(token);
      }

      // The stale raw token cannot authorize an action, even after the newer list completes.
      const denied = await wrapper(
        pi,
        "cua_click",
        { pid: 42, window_id: 100, element_token: token },
        `stale-token-${order}`,
      );
      expect(denied).toMatchObject({ isError: true });
      const fresh = await wrapper(
        pi,
        "cua_get_window_state",
        { pid: 42, window_id: 100 },
        `post-list-snapshot-${order}`,
      );
      expect(fresh).toMatchObject({ isError: false });
      const postListClick = await wrapper(
        pi,
        "cua_click",
        { pid: 42, window_id: 100, element_token: token },
        `post-list-click-${order}`,
      );
      expect(postListClick.isError).not.toBe(true);
    },
  );

  it("confirms only type_text with the exact UIA ValuePattern read-back before the next action", async () => {
    const pi = new MockPi();
    const events: string[] = [];
    let n = 0;
    const gate: CuaRecoveryGate = {
      beginAction: () => {
        events.push("begin");
        return `action-${++n}`;
      },
      recordOutcome: (id, outcome) => events.push(`outcome:${id}:${outcome}`),
      recordAbort: (id) => events.push(`abort:${id}`),
    };
    enable(pi, false, true, gate, () => events.push("dispatch"));
    await observed(pi);
    const result = await wrapper(
      pi,
      "cua_type_text",
      { pid: 42, window_id: 100, element_token: token, text: "safe" },
      "gated-action",
    );
    expect(result).toMatchObject({ content: [{ type: "text" }] });
    expect(events).toEqual(["begin", "dispatch", "outcome:action-1:confirmed_applied"]);

    // Consumed tokens require a new snapshot before another action can even ask the gate.
    const withoutFreshSnapshot = await wrapper(
      pi,
      "cua_click",
      { pid: 42, window_id: 100, element_token: token },
      "stale-after-type",
    );
    expect(withoutFreshSnapshot).toMatchObject({ isError: true });

    await wrapper(pi, "cua_get_window_state", { pid: 42, window_id: 100 }, "fresh-state");
    await wrapper(
      pi,
      "cua_click",
      { pid: 42, window_id: 100, element_token: token },
      "click-remains-ambiguous",
    );
    expect(events.at(-1)).toBe("outcome:action-2:ambiguous");
  });

  it("fails closed before native dispatch when durable intent cannot be written", async () => {
    const pi = new MockPi();
    let dispatched = 0;
    enable(
      pi,
      false,
      false,
      {
        beginAction: () => {
          throw new Error("disk unavailable");
        },
        recordOutcome: () => {},
        recordAbort: () => {},
      },
      () => dispatched++,
    );
    await observed(pi);
    const result = await wrapper(
      pi,
      "cua_click",
      { pid: 42, window_id: 100, element_token: token },
      "gate-failure",
    );
    expect(result).toMatchObject({ isError: true });
    expect(dispatched).toBe(0);
  });

  it("allows reads but blocks actions before dispatch when no recovery gate is installed", async () => {
    const pi = new MockPi();
    let dispatched = 0;
    enable(pi, false, false, undefined, () => dispatched++, undefined, true);

    await observed(pi);
    const read = await wrapper(
      pi,
      "cua_get_window_state",
      { pid: 42, window_id: 100 },
      "no-gate-read",
    );
    expect(read).toMatchObject({ content: [{ type: "text" }, { type: "image" }] });

    const result = await wrapper(
      pi,
      "cua_click",
      { pid: 42, window_id: 100, element_token: token },
      "no-gate-click",
    );
    expect(result).toMatchObject({ isError: true });
    expect("text" in result ? result.text : resultText(result)).toMatch(
      /Recovery gate .*заблокирован.*решения владельца/,
    );
    expect(dispatched).toBe(0);
  });

  it("records Stop against its action lease and ignores a later tool result", async () => {
    const pi = new MockPi();
    const events: string[] = [];
    const gate: CuaRecoveryGate = {
      beginAction: () => "stop-action",
      recordOutcome: (_id, outcome) => events.push(`outcome:${outcome}`),
      recordAbort: (id) => events.push(`abort:${id}`),
    };
    const abortNextAction = enable(pi, false, false, gate);
    await observed(pi);
    abortNextAction();
    const result = await wrapper(
      pi,
      "cua_click",
      { pid: 42, window_id: 100, element_token: token },
      "stop-action-wrapper",
    );
    expect(result).toMatchObject({ isError: true });
    expect(events).toEqual(["abort:stop-action"]);
    await pi.userPrompt("new turn");
    expect(events).toEqual(["abort:stop-action"]);
  });

  it("records AbortSignal before agent_settled and ignores the later type_text result", async () => {
    const pi = new MockPi();
    const events: string[] = [];
    const gate: CuaRecoveryGate = {
      beginAction: () => "signal-action",
      recordOutcome: (_id, outcome) => events.push(`outcome:${outcome}`),
      recordAbort: (id) => events.push(`abort:${id}`),
    };
    let entered!: () => void;
    let release!: () => void;
    const atAction = new Promise<void>((resolve) => (entered = resolve));
    const resultBarrier = new Promise<void>((resolve) => (release = resolve));
    enable(pi, true, true, gate, undefined, async () => {
      entered();
      await resultBarrier;
    });
    await observed(pi);
    const controller = new AbortController();
    const pending = wrapper(
      pi,
      "cua_type_text",
      { pid: 42, window_id: 100, element_token: token, text: "written" },
      "signal-wrapper",
      controller.signal,
    );
    await atAction;
    controller.abort();
    expect(events).toEqual(["abort:signal-action"]);
    await pi.emit("agent_settled", { aborted: true });
    await pi.emit("agent_settled", { aborted: true });
    release();
    expect(await pending).toMatchObject({ isError: true });
    expect(events).toEqual(["abort:signal-action"]);
  });

  it("persists unknown on rejected executeTool, cleans the lease, and ignores a late result", async () => {
    const pi = new MockPi();
    const events: string[] = [];
    const gate: CuaRecoveryGate = {
      beginAction: () => "lost-result-action",
      recordOutcome: (_id, outcome) => events.push(`outcome:${outcome}`),
      recordAbort: (id) => events.push(`abort:${id}`),
    };
    enable(pi, false, true, gate, undefined, async () => {
      throw new Error("nested execution rejected before tool_result");
    });
    await observed(pi);
    const result = await wrapper(
      pi,
      "cua_type_text",
      { pid: 42, window_id: 100, element_token: token, text: "possibly written" },
      "lost-result-wrapper",
    );
    expect(result).toMatchObject({ isError: true });
    expect(events).toEqual(["outcome:ambiguous"]);

    await pi.emit("tool_result", {
      toolName: "mcp__cuaComputerUse__type_text",
      toolCallId: "lost-result-wrapper/1",
      content: [{ type: "text", text: "late apparent success" }],
      structuredContent: {
        structuredContent: {
          effect: "confirmed",
          evidence: [{ kind: "value_readback", detail: "confirmed" }],
        },
      },
      isError: false,
    });
    expect(events).toEqual(["outcome:ambiguous"]);
  });

  it("cleans a durable intent when a later Pi tool_call hook blocks before tool_result", async () => {
    const pi = new MockPi();
    const events: string[] = [];
    let dispatched = 0;
    const gate: CuaRecoveryGate = {
      beginAction: () => "late-hook-action",
      recordOutcome: (_id, outcome) => events.push(`outcome:${outcome}`),
      recordAbort: (id) => events.push(`abort:${id}`),
    };
    enable(pi, false, true, gate, () => dispatched++);
    pi.handlers
      .get("tool_call")
      ?.push(async (event) =>
        event.toolName === "mcp__cuaComputerUse__click"
          ? { block: true, reason: "blocked by a later hook" }
          : undefined,
      );
    await observed(pi);

    const result = await wrapper(
      pi,
      "cua_click",
      { pid: 42, window_id: 100, element_token: token },
      "late-hook-wrapper",
    );
    expect(result).toMatchObject({ isError: true });
    expect(events).toEqual(["outcome:ambiguous"]);
    expect(dispatched).toBe(0);

    // Pi returns an immediate preflight error without running afterToolCall/tool_result.
    await pi.emit("tool_result", {
      toolName: "mcp__cuaComputerUse__click",
      toolCallId: "late-hook-wrapper/1",
      content: [{ type: "text", text: "late result" }],
      isError: false,
      structuredContent: { effect: "confirmed" },
    });
    expect(events).toEqual(["outcome:ambiguous"]);
  });

  it.each([
    { output: { effect: "confirmed" }, label: "missing evidence" },
    {
      output: {
        effect: "confirmed",
        evidence: [{ kind: "value_readback", detail: "unconfirmed" }],
      },
      label: "false evidence",
    },
  ])("keeps type_text ambiguous with $label", async ({ output }) => {
    const pi = new MockPi();
    const outcomes: string[] = [];
    const gate: CuaRecoveryGate = {
      beginAction: () => "evidence-action",
      recordOutcome: (_id, outcome) => outcomes.push(outcome),
      recordAbort: () => {},
    };
    enable(pi, false, false, gate);
    await observed(pi);
    // Replace the mock's standard response after it reaches the raw tool result hook.
    const rawResult = pi.handlers.get("tool_result") ?? [];
    const appendBadEvidence = async (event: Record<string, unknown>) => {
      if (event.toolName === "mcp__cuaComputerUse__type_text") {
        event.structuredContent = { structuredContent: output };
      }
      return undefined;
    };
    rawResult.unshift(appendBadEvidence as never);
    const result = await wrapper(
      pi,
      "cua_type_text",
      { pid: 42, window_id: 100, element_token: token, text: "x" },
      "bad-evidence",
    );
    expect(outcomes).toEqual(["ambiguous"]);
    expect(resultText(result)).toMatch(/Recovery gate .*заблокирован.*решения владельца/);
  });

  it("keeps a driver-confirmed click blocked and asks for owner resolution", async () => {
    const pi = new MockPi();
    const outcomes: string[] = [];
    const gate: CuaRecoveryGate = {
      beginAction: () => "click-action",
      recordOutcome: (_id, outcome) => outcomes.push(outcome),
      recordAbort: () => {},
    };
    enable(pi, false, true, gate);
    await observed(pi);
    const result = await wrapper(
      pi,
      "cua_click",
      { pid: 42, window_id: 100, element_token: token },
      "confirmed-click",
    );
    expect(outcomes).toEqual(["ambiguous"]);
    expect(resultText(result)).toMatch(/Recovery gate .*заблокирован.*решения владельца/);
  });

  it("keeps the wrapper blocked when outcome persistence fails", async () => {
    const pi = new MockPi();
    const gate: CuaRecoveryGate = {
      beginAction: () => "persistence-action",
      recordOutcome: () => {
        throw new Error("disk unavailable");
      },
      recordAbort: () => {},
    };
    enable(pi, false, true, gate);
    await observed(pi);
    const result = await wrapper(
      pi,
      "cua_type_text",
      { pid: 42, window_id: 100, element_token: token, text: "written" },
      "persistence-failure",
    );
    expect(resultText(result)).toMatch(/Recovery gate .*заблокирован.*решения владельца/);
    expect(resultText(result)).not.toMatch(/подтверждено безопасно[^\n]*разрешено/i);
  });

  it("allows reads but lets a shared unresolved gate block concurrent later actions", async () => {
    const pi = new MockPi();
    let unresolved = false;
    let dispatched = 0;
    const gate: CuaRecoveryGate = {
      beginAction: () => {
        if (unresolved) throw new Error("profile action unresolved");
        unresolved = true;
        return "only-action";
      },
      recordOutcome: () => {},
      recordAbort: () => {},
    };
    enable(pi, false, false, gate, () => dispatched++);
    await observed(pi);
    await wrapper(
      pi,
      "cua_type_text",
      { pid: 42, window_id: 100, element_token: token, text: "one" },
      "first-action",
    );
    const read = await wrapper(
      pi,
      "cua_get_window_state",
      { pid: 42, window_id: 100 },
      "read-while-blocked",
    );
    expect(read).toMatchObject({ content: [{ type: "text" }, { type: "image" }] });
    const blocked = await wrapper(
      pi,
      "cua_type_text",
      { pid: 42, window_id: 100, element_token: token, text: "two" },
      "second-action",
    );
    expect(blocked).toMatchObject({ isError: true });
    expect(dispatched).toBe(1);
  });

  it("does not append an uncertainty warning after confirmed input is durably recorded", async () => {
    const pi = new MockPi();
    const gate: CuaRecoveryGate = {
      beginAction: () => "persisted-confirmation",
      recordOutcome: () => {},
      recordAbort: () => {},
    };
    enable(pi, false, true, gate);
    await observed(pi);
    const result = await wrapper(
      pi,
      "cua_type_text",
      { pid: 42, window_id: 100, element_token: token, text: "ok" },
      "confirmed",
    );
    expect(result).toMatchObject({ content: [{ type: "text" }] });
    expect(resultText(result)).not.toContain("Recovery gate");
  });
  it("accepts tokens from the real default markdown snapshot shape", async () => {
    const pi = new MockPi();
    enable(pi, true);
    await observed(pi);
    expect(
      await wrapper(
        pi,
        "cua_click",
        { pid: 42, window_id: 100, element_token: token },
        "markdown-click",
      ),
    ).toMatchObject({
      content: [
        { type: "text" },
        { type: "text", text: expect.stringContaining("решения владельца") },
      ],
    });
  });
  it("exposes narrow model schemas and denies every raw Cua call", async () => {
    const pi = new MockPi();
    enable(pi);
    for (const [name, required] of [
      ["cua_get_window_state", ["pid", "window_id"]],
      ["cua_click", ["pid", "window_id", "element_token"]],
      ["cua_type_text", ["pid", "window_id", "element_token", "text"]],
    ] as const) {
      const schema = pi.tool(name).parameters as {
        required?: string[];
        additionalProperties?: boolean;
      };
      expect(schema.required).toEqual(required);
      expect(schema.additionalProperties).toBe(false);
    }
    await pi.userPrompt();
    expect(
      await pi.toolCall(
        "mcp__cuaComputerUse__click",
        {
          pid: 42,
          window_id: 100,
          element_token: token,
        },
        "raw-direct",
      ),
    ).toMatchObject({ block: true });
    expect(await pi.toolCall("mcp__cuaComputerUse__screenshot", {}, "unallowed")).toMatchObject({
      block: true,
    });
  });

  it("requires list_windows membership and keeps the selected window; preserves images", async () => {
    const pi = new MockPi();
    enable(pi);
    await observed(pi);
    expect(
      await wrapper(
        pi,
        "cua_get_window_state",
        {
          pid: 42,
          window_id: 200,
        },
        "different-window",
      ),
    ).toMatchObject({ isError: true });
    const result = await wrapper(
      pi,
      "cua_click",
      {
        pid: 42,
        window_id: 100,
        element_token: token,
      },
      "click-wrapper",
    );
    expect(result).toMatchObject({
      content: [
        { type: "text" },
        { type: "text", text: expect.stringContaining("решения владельца") },
      ],
    });
    const nextSnapshot = await wrapper(
      pi,
      "cua_get_window_state",
      {
        pid: 42,
        window_id: 100,
      },
      "image-snapshot",
    );
    expect(nextSnapshot).toMatchObject({
      content: [{ type: "text" }, { type: "image", data: "AQID", mimeType: "image/png" }],
    });
  });

  it("blocks missing/stale tokens and coordinate, target, desktop, and focus routes", async () => {
    const pi = new MockPi();
    enable(pi);
    await observed(pi);
    let rejected = 0;
    for (const params of [
      { pid: 42, window_id: 100 },
      { pid: 42, window_id: 100, element_token: "s1234abcd:99" },
      { pid: 42, window_id: 100, element_token: token, x: 2, y: 3 },
      {
        pid: 42,
        window_id: 100,
        element_token: token,
        target: { kind: "desktop", display_id: "primary" },
      },
      { pid: 42, window_id: 100, element_token: token, scope: "desktop" },
      { pid: 42, window_id: 100, element_token: token, delivery_mode: "foreground" },
    ]) {
      const result = await wrapper(pi, "cua_click", params, `rejected-${++rejected}`);
      expect(result).toMatchObject({ isError: true });
    }
    expect(
      await wrapper(
        pi,
        "cua_type_text",
        {
          pid: 42,
          window_id: 100,
          element_token: token,
          text: "safe",
        },
        "type-wrapper",
      ),
    ).toMatchObject({
      content: [
        { type: "text" },
        { type: "text", text: expect.stringContaining("решения владельца") },
      ],
    });
    expect(
      await wrapper(
        pi,
        "cua_click",
        {
          pid: 42,
          window_id: 100,
          element_token: token,
        },
        "token-consumed",
      ),
    ).toMatchObject({ isError: true });
  });

  it("reports unknown outcome and refuses retry when Stop arrives during an action", async () => {
    const pi = new MockPi();
    const abortNextAction = enable(pi);
    await observed(pi);
    abortNextAction();
    const unknown = await wrapper(
      pi,
      "cua_click",
      {
        pid: 42,
        window_id: 100,
        element_token: token,
      },
      "action-stop",
    );
    expect(unknown).toMatchObject({ isError: true });
    expect("text" in unknown ? unknown.text : "").toMatch(
      /Результат действия Cua неизвестен.*Recovery gate.*решения владельца/u,
    );
    expect(
      await wrapper(
        pi,
        "cua_click",
        {
          pid: 42,
          window_id: 100,
          element_token: token,
        },
        "after-action-stop",
      ),
    ).toMatchObject({ isError: true });
  });

  it("applies the late image tombstone through real Pi tool_result hooks after session.abort", async () => {
    const root = await mkdtemp(join(tmpdir(), "cua-wrapper-pi-stop-"));
    const agentDir = join(root, "agent");
    const project = join(root, "project");
    await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(project, { recursive: true })]);
    const server = new ScriptedOpenAiServer((_request, index) =>
      index === 0
        ? { toolCalls: [{ name: "cua_list_windows", arguments: {} }] }
        : index === 1
          ? {
              toolCalls: [{ name: "cua_get_window_state", arguments: { pid: 42, window_id: 100 } }],
            }
          : { text: "unexpected model continuation" },
    );
    await server.start();
    const image = { type: "image", data: "AQID", mimeType: "image/png" } as const;
    let markSnapshotStarted!: () => void;
    let releaseSnapshot!: () => void;
    let markSignalAborted!: () => void;
    const snapshotStarted = new Promise<void>((resolve) => (markSnapshotStarted = resolve));
    const snapshotBarrier = new Promise<void>((resolve) => (releaseSnapshot = resolve));
    const signalAborted = new Promise<void>((resolve) => (markSignalAborted = resolve));
    let stoppedResult:
      | { content?: unknown[]; structuredContent?: unknown; isError?: boolean }
      | undefined;
    const gate: CuaRecoveryGate = {
      beginAction: () => "unused-action",
      recordOutcome: () => {},
      recordAbort: () => {},
    };
    let runtime: Awaited<ReturnType<typeof createPixRuntime>> | undefined;
    try {
      await writeFile(
        join(agentDir, "models.json"),
        JSON.stringify({
          providers: {
            gw: {
              baseUrl: server.baseUrl,
              api: "openai-completions",
              apiKey: "fixture-key",
              compat: {
                supportsDeveloperRole: false,
                supportsStore: false,
                maxTokensField: "max_tokens",
              },
              models: [
                {
                  id: "cua-stop-test",
                  name: "Cua Stop test",
                  reasoning: false,
                  input: ["text", "image"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 8192,
                  maxTokens: 512,
                },
              ],
            },
          },
        }),
      );
      runtime = await createPixRuntime({
        cwd: project,
        agentDir,
        model: { provider: "gw", id: "cua-stop-test" },
        tools: [
          "cua_list_windows",
          "cua_get_window_state",
          "mcp__cuaComputerUse__list_windows",
          "mcp__cuaComputerUse__get_window_state",
        ],
        extensionFactories: [
          (pi) => {
            installCuaComputerUseGuard(pi, gate);
            pi.registerTool({
              name: "mcp__cuaComputerUse__list_windows",
              label: "raw window list",
              description: "test fixture",
              exposure: "codemode",
              parameters: Type.Object(
                { pid: Type.Optional(Type.Integer({ minimum: 1 })) },
                { additionalProperties: false },
              ),
              async execute() {
                return {
                  content: [{ type: "text", text: "window list" }],
                  details: {},
                  structuredContent: {
                    windows: [
                      { pid: 42, window_id: 100 },
                      { pid: 42, window_id: 200 },
                    ],
                  },
                };
              },
            });
            pi.registerTool({
              name: "mcp__cuaComputerUse__get_window_state",
              label: "raw window state",
              description: "test fixture",
              exposure: "codemode",
              parameters: Type.Object(
                { pid: Type.Integer({ minimum: 1 }), window_id: Type.Integer({ minimum: 1 }) },
                { additionalProperties: false },
              ),
              async execute(_id, _args, signal) {
                markSnapshotStarted();
                if (signal?.aborted) markSignalAborted();
                else signal?.addEventListener("abort", markSignalAborted, { once: true });
                await snapshotBarrier;
                return {
                  content: [{ type: "text", text: "snapshot [7]" }, image],
                  details: {},
                  structuredContent: {
                    snapshot_id: "s1234abcd",
                    elements: [{ element_token: token }],
                  },
                };
              },
            });
            pi.on("tool_result", (event) => {
              if (event.toolName !== "mcp__cuaComputerUse__get_window_state") return;
              stoppedResult = {
                content: event.content as unknown[],
                structuredContent: event.structuredContent,
                isError: event.isError,
              };
            });
          },
        ],
      });
      const prompt = runtime.runtime.session.prompt("Inspect the window state.");
      await snapshotStarted;
      const abort = runtime.runtime.session.abort();
      await signalAborted;
      releaseSnapshot();
      await Promise.allSettled([prompt, abort]);

      expect(stoppedResult?.isError).toBe(true);
      expect(
        stoppedResult?.content?.some((part) => (part as { type?: string }).type === "image"),
      ).toBe(false);
      expect(stoppedResult?.structuredContent).toBeUndefined();
      expect(JSON.stringify(stoppedResult)).toMatch(/отброшен после Stop/u);
      expect(server.requests).toHaveLength(2);
      expect(JSON.stringify(server.requests)).not.toContain("AQID");
      expect(JSON.stringify(runtime.runtime.session.messages)).not.toContain("AQID");
    } finally {
      releaseSnapshot();
      await runtime?.dispose();
      await server.stop();
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
