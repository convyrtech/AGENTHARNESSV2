import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { Type } from "typebox";
import { createPixRuntime } from "../../agent-runtime/src/index.ts";
import { installMunimComputerUseGuard, type MunimRecoveryGate } from "../src/munim-computer-use.ts";
import { MockPi } from "./mock-pi.ts";

const PID = 42;
const list = "Fixture  [fixture]  pid=42 windows=1";
const state = "42 (pid 42) [e1] Edit [e2] Button";
const image = { type: "image", data: "AQID", mimeType: "image/png" } as const;

function harness(
  options: {
    gate?: MunimRecoveryGate | null;
    listText?: string;
    stateText?: string;
    deferState?: () => Promise<void>;
    beforeRawAction?: () => Promise<void>;
    deferRawResult?: (rawName: string) => Promise<void>;
  } = {},
) {
  const pi = new MockPi();
  const log = { begin: [] as unknown[], outcomes: [] as unknown[], aborts: [] as string[] };
  const gate: MunimRecoveryGate = options.gate ?? {
    beginAction(input) {
      log.begin.push(input);
      return `action-${log.begin.length}`;
    },
    recordOutcome(id, outcome) {
      log.outcomes.push([id, outcome]);
    },
    recordAbort(id) {
      log.aborts.push(id);
    },
  };
  installMunimComputerUseGuard(pi.api, options.gate === null ? undefined : gate);
  let serial = 0;
  let dispatches = 0;
  const toolResultOutputs = new Map<string, unknown>();
  async function run(
    name:
      | "munim_list_apps"
      | "munim_get_app_state"
      | "munim_click"
      | "munim_type_text"
      | "munim_screenshot",
    params: Record<string, unknown> = {},
    id = `wrapper-${++serial}`,
    signal?: AbortSignal,
  ) {
    const tool = pi.tool(name);
    const ctx = {
      ...pi.ctx,
      executeTool: async (
        rawName: string,
        args: Record<string, unknown>,
        _opts?: { signal?: AbortSignal },
      ) => {
        if (
          rawName.endsWith("click") ||
          rawName.endsWith("type_text") ||
          rawName.endsWith("screenshot")
        )
          await options.beforeRawAction?.();
        const rawCallId = `${id}/raw-${++serial}`;
        const blocked = await pi.toolCall(rawName, args, rawCallId, id);
        if (blocked)
          return {
            isError: true,
            result: { content: [{ type: "text", text: blocked.reason ?? "blocked" }] },
          };
        if (
          rawName.endsWith("click") ||
          rawName.endsWith("type_text") ||
          rawName.endsWith("screenshot")
        )
          dispatches += 1;
        if (rawName.endsWith("get_app_state")) await options.deferState?.();
        await options.deferRawResult?.(rawName);
        const text = rawName.endsWith("list_apps")
          ? (options.listText ?? list)
          : rawName.endsWith("get_app_state")
            ? (options.stateText ?? state)
            : "action accepted";
        const content = [
          { type: "text", text },
          ...(rawName.endsWith("get_app_state") || rawName.endsWith("screenshot") ? [image] : []),
        ];
        const event = {
          toolName: rawName,
          toolCallId: rawCallId,
          parentToolCallId: id,
          content,
          structuredContent: rawName.endsWith("get_app_state")
            ? { text, element_id: "e1" }
            : { text },
          isError: false,
        };
        const hookResults = await pi.emit("tool_result", event);
        const hookResult = hookResults.find((value) => value && typeof value === "object") as
          | { content?: unknown[]; structuredContent?: unknown; isError?: boolean }
          | undefined;
        const appliedContent = hookResult?.content ?? content;
        const applied = {
          content: appliedContent,
          structuredContent: hookResult ? hookResult.structuredContent : event.structuredContent,
          isError: hookResult?.isError ?? false,
        };
        toolResultOutputs.set(rawCallId, applied);
        return {
          isError: hookResult?.isError ?? false,
          result: {
            content: appliedContent,
            ...(applied.structuredContent === undefined
              ? {}
              : { structuredContent: applied.structuredContent }),
          },
        };
      },
    } as typeof pi.ctx;
    return tool.execute(id, params, signal, () => {}, ctx as never) as Promise<{
      content?: unknown[];
      structuredContent?: unknown;
    }>;
  }
  return {
    pi,
    log,
    run,
    get dispatches() {
      return dispatches;
    },
    toolResultOutputs,
  };
}

async function ready(h: ReturnType<typeof harness>, pid = PID) {
  await h.run("munim_list_apps");
  return h.run("munim_get_app_state", { pid });
}

function returnedToken(result: { content?: unknown[] }, shortId = "e1"): string {
  const text = (result.content ?? [])
    .filter((part) => (part as { type?: string }).type === "text")
    .map((part) => (part as { text?: string }).text ?? "")
    .join("\n");
  const match = text.match(/munim_v1\.[0-9a-f-]{36}\.\d+/u);
  expect(text).not.toContain(`[${shortId}]`);
  if (!match) throw new Error(`opaque token missing from output: ${text}`);
  return match[0]!;
}

function deferredStep() {
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    ready,
    release,
    wait: async () => {
      started();
      await held;
    },
  };
}

describe("Munim wrapper guard scaffold", () => {
  it("accepts the backend-failure fixture list row through the production guard", async () => {
    const accepted = harness({
      listText: `PRSLOY Backend Failure Fixture [fixture] pid=${PID} windows=1`,
    });
    await accepted.run("munim_list_apps");
    await accepted.run("munim_get_app_state", { pid: PID });
    expect(accepted.toolResultOutputs.size).toBe(2);

    const rejected = harness({ listText: `${PID} (pid=${PID}) windows=1` });
    await rejected.run("munim_list_apps");
    await expect(rejected.run("munim_get_app_state", { pid: PID })).rejects.toThrow(/windows=1/u);
    expect(rejected.toolResultOutputs.size).toBe(1);
  });

  it("blocks raw bypass without parentToolCallId and exposes only the four wrappers", async () => {
    const h = harness();
    expect([...h.pi.tools.keys()].sort()).toEqual([
      "munim_click",
      "munim_get_app_state",
      "munim_list_apps",
      "munim_screenshot",
      "munim_type_text",
    ]);
    h.pi.activeTools.push("mcp__munimComputerUse__click", "mcp__munimComputerUse__screenshot");
    await h.pi.userPrompt();
    expect(h.pi.activeTools.filter((name) => name.startsWith("mcp__munimComputerUse__"))).toEqual(
      [],
    );
    expect(h.pi.activeTools.filter((name) => name.startsWith("munim_")).sort()).toEqual([
      "munim_click",
      "munim_get_app_state",
      "munim_list_apps",
      "munim_screenshot",
      "munim_type_text",
    ]);
    expect(
      await h.pi.toolCall("mcp__munimComputerUse__click", { app: "42", element_id: "e1" }),
    ).toMatchObject({ block: true });
    expect(await h.pi.toolCall("mcp__munimComputerUse__screenshot", {})).toMatchObject({
      block: true,
    });
    expect(h.dispatches).toBe(0);
  });

  it("preserves image content while replacing eN with opaque generation tokens; old token fails after same eN snapshot", async () => {
    const h = harness();
    const first = await ready(h);
    const oldToken = returnedToken(first);
    expect(
      first.content?.some(
        (part) =>
          (part as { type?: string }).type === "image" &&
          (part as { data?: string }).data === "AQID",
      ),
    ).toBe(true);
    const second = await h.run("munim_get_app_state", { pid: PID });
    const newToken = returnedToken(second);
    expect(newToken).not.toBe(oldToken);
    await expect(h.run("munim_click", { pid: PID, element_token: oldToken })).rejects.toThrow(
      /Токен устарел/u,
    );
    expect(h.dispatches).toBe(0);
  });

  it("passes screenshot images unchanged, rejects a different PID, and preserves current tokens", async () => {
    const h = harness();
    const token = returnedToken(await ready(h));
    const result = await h.run("munim_screenshot", { pid: PID });
    expect(result.content).toEqual([{ type: "text", text: "action accepted" }, image]);
    await expect(h.run("munim_screenshot", { pid: PID + 1 })).rejects.toThrow(/windows=1/u);
    expect(h.dispatches).toBe(1);
    await expect(h.run("munim_click", { pid: PID, element_token: token })).rejects.toThrow(
      /Результат неизвестен/u,
    );
    expect(h.dispatches).toBe(2);
  });

  it("drops late list_apps results after Stop without restoring a PID report", async () => {
    const deferred = deferredStep();
    const h = harness({
      deferRawResult: async (rawName) => {
        if (rawName.endsWith("list_apps")) await deferred.wait();
      },
    });
    const listing = h.run("munim_list_apps");
    await deferred.ready;
    await h.pi.emit("agent_settled", { aborted: true });
    deferred.release();
    await expect(listing).rejects.toThrow(/Stop/u);
    const result = [...h.toolResultOutputs.values()].at(-1) as {
      content?: { type?: string; text?: string }[];
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content?.map((part) => part.text ?? "").join(" ")).not.toContain("pid=42");
    await expect(h.run("munim_get_app_state", { pid: PID })).rejects.toThrow(/windows=1/u);
  });

  it("drops late get_app_state content after Stop without publishing tokens", async () => {
    const deferred = deferredStep();
    const h = harness({
      deferRawResult: async (rawName) => {
        if (rawName.endsWith("get_app_state")) await deferred.wait();
      },
    });
    await h.run("munim_list_apps");
    const reading = h.run("munim_get_app_state", { pid: PID });
    await deferred.ready;
    await h.pi.emit("agent_settled", { aborted: true });
    deferred.release();
    await expect(reading).rejects.toThrow(/Stop/u);
    const result = [...h.toolResultOutputs.values()].at(-1) as {
      content?: { type?: string; text?: string }[];
      structuredContent?: unknown;
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content?.map((part) => part.text ?? "").join(" ")).not.toContain("[e1]");
    expect(result.content?.some((part) => part.type === "image")).toBe(false);
    expect(result.structuredContent).toBeUndefined();
    await expect(h.run("munim_click", { pid: PID, element_token: "stale" })).rejects.toThrow(
      /PID с последнего отчёта/u,
    );
  });

  it("discards a screenshot image that arrives after Stop", async () => {
    const deferred = deferredStep();
    const h = harness({
      deferRawResult: async (rawName) => {
        if (rawName.endsWith("screenshot")) await deferred.wait();
      },
    });
    const token = returnedToken(await ready(h));
    const controller = new AbortController();
    const screenshot = h.run("munim_screenshot", { pid: PID }, undefined, controller.signal);
    await deferred.ready;
    controller.abort();
    await expect(h.run("munim_list_apps")).rejects.toThrow(/конкурентный вызов/u);
    deferred.release();
    await expect(screenshot).rejects.toThrow(/Stop/u);
    const result = [...h.toolResultOutputs.values()].at(-1) as {
      content?: { type?: string; text?: string }[];
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content?.some((part) => part.type === "image")).toBe(false);
    expect(result.content?.map((part) => part.text ?? "").join(" ")).toMatch(
      /отброшен после Stop/u,
    );
    await expect(h.run("munim_click", { pid: PID, element_token: token })).rejects.toThrow(
      /PID с последнего отчёта/u,
    );
  });

  it("rejects mismatched PID, multiple windows, and a missing recovery gate", async () => {
    const h = harness();
    const result = await ready(h);
    const token = returnedToken(result);
    await expect(h.run("munim_click", { pid: 77, element_token: token })).rejects.toThrow(
      /PID с последнего отчёта/u,
    );
    expect(h.dispatches).toBe(0);
    const multi = harness({ listText: "Fixture  [fixture]  pid=42 windows=2" });
    await multi.run("munim_list_apps");
    await expect(multi.run("munim_get_app_state", { pid: 42 })).rejects.toThrow(/windows=1/u);
    const noGate = harness({ gate: null });
    const noGateResult = await ready(noGate);
    await expect(
      noGate.run("munim_click", { pid: PID, element_token: returnedToken(noGateResult) }),
    ).rejects.toThrow(/durable recovery gate/u);
    expect(noGate.dispatches).toBe(0);
  });

  it("drops malformed or mismatched snapshots instead of returning the raw nested result", async () => {
    const h = harness({ stateText: "43 (pid 43) [e1] Private raw row" });
    await h.run("munim_list_apps");
    await expect(h.run("munim_get_app_state", { pid: PID })).rejects.toThrow(
      /snapshot не прошёл guard/u,
    );
    const applied = [...h.toolResultOutputs.values()].at(-1) as {
      content?: { type?: string; text?: string }[];
      structuredContent?: unknown;
    };
    expect(applied.content?.map((part) => part.text ?? "").join(" ")).not.toContain(
      "Private raw row",
    );
    expect(applied.content?.map((part) => part.text ?? "").join(" ")).not.toContain("[e1]");
    expect(applied.structuredContent).toBeUndefined();
  });

  it("fails closed if durable beginAction fails and invalidates the token before dispatch", async () => {
    const h = harness({
      gate: {
        beginAction() {
          throw new Error("disk unavailable");
        },
        recordOutcome() {},
        recordAbort() {},
      },
    });
    const result = await ready(h);
    const token = returnedToken(result);
    await expect(h.run("munim_click", { pid: PID, element_token: token })).rejects.toThrow(
      /Recovery gate не сохранил intent/u,
    );
    expect(h.dispatches).toBe(0);
    await expect(h.run("munim_click", { pid: PID, element_token: token })).rejects.toThrow(
      /Токен устарел/u,
    );
  });

  it("records unknown after action dispatch and abort; wrapper does not claim success", async () => {
    const h = harness();
    const result = await ready(h);
    const token = returnedToken(result);
    await expect(h.run("munim_click", { pid: PID, element_token: token })).rejects.toThrow(
      /Результат неизвестен/u,
    );
    expect(h.dispatches).toBe(1);
    expect(h.log.outcomes).toEqual([["action-1", "unknown"]]);
    expect(h.log.begin[0]).toEqual({ operationId: expect.any(String), pid: PID, kind: "click" });
    expect(h.log.begin[0]).not.toHaveProperty("windowId");

    const abortHarness = harness();
    const abortToken = returnedToken(await ready(abortHarness));
    const abortCtx = {
      ...abortHarness.pi.ctx,
      executeTool: async (rawName: string, args: Record<string, unknown>) => {
        const rawCallId = "wrapper-abort/raw";
        const blocked = await abortHarness.pi.toolCall(rawName, args, rawCallId, "wrapper-abort");
        expect(blocked).toBeUndefined();
        await abortHarness.pi.emit("agent_settled", { aborted: true });
        return { isError: true, result: { content: [{ type: "text", text: "cancelled" }] } };
      },
    } as typeof abortHarness.pi.ctx;
    const actionTool = abortHarness.pi.tool("munim_click");
    await expect(
      actionTool.execute(
        "wrapper-abort",
        { pid: PID, element_token: abortToken },
        undefined,
        () => {},
        abortCtx as never,
      ),
    ).rejects.toThrow(/Stop/u);
    expect(abortHarness.log.aborts).toContain("action-1");
  });

  it("blocks a prepared raw action when Stop arrives before the raw tool hook", async () => {
    let releaseRaw!: () => void;
    let rawStarted!: () => void;
    const rawStartedPromise = new Promise<void>((resolve) => {
      rawStarted = resolve;
    });
    const rawBarrier = new Promise<void>((resolve) => {
      releaseRaw = resolve;
    });
    const h = harness({
      beforeRawAction: async () => {
        rawStarted();
        await rawBarrier;
      },
    });
    const token = returnedToken(await ready(h));
    const action = h.run("munim_click", { pid: PID, element_token: token });
    await rawStartedPromise;
    await h.pi.emit("agent_settled", { aborted: true });
    releaseRaw();
    await expect(action).rejects.toThrow(/Stop/u);
    expect(h.dispatches).toBe(0);
    expect(h.log.aborts).toEqual(["action-1"]);
    expect(h.log.outcomes).toEqual([]);
  });

  it("blocks overlapping snapshots so the later completion cannot replace the current generation", async () => {
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({
      deferState: async () => {
        started();
        await gate;
      },
    });
    await h.run("munim_list_apps");
    const first = h.run("munim_get_app_state", { pid: PID }, "snapshot-one");
    await startedPromise;
    await expect(h.run("munim_get_app_state", { pid: PID }, "snapshot-two")).rejects.toThrow(
      /конкурентный вызов/u,
    );
    release();
    const result = await first;
    const token = returnedToken(result);
    expect(token).toMatch(/^munim_v1\./u);
    expect(h.dispatches).toBe(0);
  });

  it("uses actual Pi nested tool schema validation and applies the tool_result hook output", async () => {
    const root = await mkdtemp(join(tmpdir(), "munim-wrapper-pi-"));
    const agentDir = join(root, "agent");
    const project = join(root, "project");
    await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(project, { recursive: true })]);
    const modelToolContents: string[] = [];
    const rawArgs: Record<string, unknown>[] = [];
    const gateLog: string[] = [];
    let toolRequestCount = 0;
    let serverFailure: string | undefined;
    let screenshotImageSeen = false;
    const server = createServer(async (request, response) => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ data: [{ id: "munim-test" }] }));
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        response.writeHead(404).end();
        return;
      }
      let body = "";
      for await (const chunk of request) body += String(chunk);
      const parsed = JSON.parse(body) as {
        messages?: {
          role?: string;
          content?: unknown;
          tool_call_id?: string;
          tool_calls?: { id?: string; function?: { name?: string } }[];
        }[];
      };
      const messages = parsed.messages ?? [];
      const toolMessages = messages.filter((message) => message.role === "tool");
      const current = toolMessages.at(-1)?.content;
      const currentText =
        typeof current === "string"
          ? current
          : Array.isArray(current)
            ? current
                .map((part) =>
                  typeof part === "object" && part && "text" in part
                    ? String((part as { text: unknown }).text)
                    : "",
                )
                .join("\n")
            : "";
      if (toolMessages.length) modelToolContents.push(currentText);
      if (toolMessages.length === 4) {
        const screenshotCall = messages
          .flatMap((message) => message.tool_calls ?? [])
          .filter((call) => call.function?.name === "munim_screenshot")
          .at(-1);
        const screenshotResultIndex = messages.findIndex(
          (message) => message.role === "tool" && message.tool_call_id === screenshotCall?.id,
        );
        screenshotImageSeen =
          screenshotResultIndex >= 0 &&
          messages
            .slice(screenshotResultIndex + 1)
            .some(
              (message) =>
                message.role === "user" && JSON.stringify(message.content).includes('"image_url"'),
            );
      }
      let toolCall: { name: string; arguments: Record<string, unknown> } | undefined;
      if (toolMessages.length === 0) toolCall = { name: "munim_list_apps", arguments: {} };
      else if (toolMessages.length === 1)
        toolCall = { name: "munim_screenshot", arguments: { pid: PID + 1 } };
      else if (toolMessages.length === 2)
        toolCall = { name: "munim_get_app_state", arguments: { pid: PID } };
      else if (toolMessages.length === 3)
        toolCall = { name: "munim_screenshot", arguments: { pid: PID } };
      else if (toolMessages.length === 4) {
        const stateResult = toolMessages[2]?.content;
        const stateText =
          typeof stateResult === "string"
            ? stateResult
            : Array.isArray(stateResult)
              ? stateResult
                  .map((part) =>
                    typeof part === "object" && part && "text" in part
                      ? String((part as { text: unknown }).text)
                      : "",
                  )
                  .join("\n")
              : "";
        const token = stateText.match(/munim_v1\.[0-9a-f-]{36}\.\d+/u)?.[0];
        if (!token)
          serverFailure = `Pi model transcript did not contain opaque token: ${stateText}`;
        else
          toolCall = {
            name: "munim_type_text",
            arguments: { pid: PID, element_token: token, text: "safe test" },
          };
      }
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const chunkOut = (delta: Record<string, unknown>, finish: string | null = null) =>
        response.write(
          `data: ${JSON.stringify({ id: "munim-wrapper-pi", object: "chat.completion.chunk", created: 1, model: "munim-test", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        );
      chunkOut({ role: "assistant", content: "" });
      if (toolCall) {
        chunkOut({
          tool_calls: [
            {
              index: 0,
              id: `pi-call-${++toolRequestCount}`,
              type: "function",
              function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) },
            },
          ],
        });
        chunkOut({}, "tool_calls");
      } else {
        chunkOut({ content: "done" });
        chunkOut({}, "stop");
      }
      chunkOut({}, null);
      response.end("data: [DONE]\n\n");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fake model server did not bind");
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    await writeFile(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          gw: {
            baseUrl,
            api: "openai-completions",
            apiKey: "fixture-key",
            compat: {
              supportsDeveloperRole: false,
              supportsStore: false,
              maxTokensField: "max_tokens",
            },
            models: [
              {
                id: "munim-test",
                name: "Munim test",
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
    const gate: MunimRecoveryGate = {
      beginAction(input) {
        gateLog.push(`begin:${input.pid}:${input.kind}`);
        return "pi-action";
      },
      recordOutcome(_id, outcome) {
        gateLog.push(`outcome:${outcome}`);
      },
      recordAbort() {
        gateLog.push("abort");
      },
    };
    const factories = [
      (pi: Parameters<typeof installMunimComputerUseGuard>[0]) => {
        installMunimComputerUseGuard(pi, gate);
        const app = Type.String();
        const element = Type.String();
        pi.registerTool({
          name: "mcp__munimComputerUse__list_apps",
          label: "raw list",
          description: "fixture",
          exposure: "codemode",
          parameters: Type.Object({}, { additionalProperties: false }),
          async execute() {
            return { content: [{ type: "text", text: list }], details: {} };
          },
        });
        pi.registerTool({
          name: "mcp__munimComputerUse__get_app_state",
          label: "raw state",
          description: "fixture",
          exposure: "codemode",
          parameters: Type.Object({ app }, { additionalProperties: false }),
          async execute(_id, args) {
            rawArgs.push(args);
            return {
              content: [{ type: "text", text: state }],
              details: {},
              structuredContent: { element_id: "e1" },
            };
          },
        });
        pi.registerTool({
          name: "mcp__munimComputerUse__screenshot",
          label: "raw screenshot",
          description: "fixture",
          exposure: "codemode",
          parameters: Type.Object({ app }, { additionalProperties: false }),
          async execute(_id, args) {
            rawArgs.push(args);
            return { content: [image], details: {} };
          },
        });
        pi.registerTool({
          name: "mcp__munimComputerUse__click",
          label: "raw click",
          description: "fixture",
          exposure: "codemode",
          parameters: Type.Object({ app, element_id: element }, { additionalProperties: false }),
          async execute(_id, args) {
            rawArgs.push(args);
            return { content: [{ type: "text", text: "clicked" }], details: {} };
          },
        });
        pi.registerTool({
          name: "mcp__munimComputerUse__type_text",
          label: "raw text",
          description: "fixture",
          exposure: "codemode",
          parameters: Type.Object(
            { app, element_id: element, text: Type.String() },
            { additionalProperties: false },
          ),
          async execute(_id, args) {
            rawArgs.push(args);
            return { content: [{ type: "text", text: "typed" }], details: {} };
          },
        });
      },
    ];
    let runtime: Awaited<ReturnType<typeof createPixRuntime>> | undefined;
    try {
      runtime = await createPixRuntime({
        cwd: project,
        agentDir,
        model: { provider: "gw", id: "munim-test" },
        tools: [
          "read",
          "munim_list_apps",
          "munim_get_app_state",
          "munim_click",
          "munim_type_text",
          "munim_screenshot",
          "mcp__munimComputerUse__list_apps",
          "mcp__munimComputerUse__get_app_state",
          "mcp__munimComputerUse__screenshot",
          "mcp__munimComputerUse__click",
          "mcp__munimComputerUse__type_text",
        ],
        extensionFactories: factories,
      });
      await runtime.runtime.session.prompt("Use tools to inspect and click the displayed item.");
      expect(rawArgs).toEqual([
        { app: "42" },
        { app: "42" },
        { app: "42", element_id: "e1", text: "safe test" },
      ]);
      expect(gateLog).toEqual(["begin:42:type_text", "outcome:unknown"]);
      expect(modelToolContents[2]).toContain("munim_v1.");
      expect(modelToolContents[2]).not.toContain("[e1]");
      expect(modelToolContents[2]).not.toContain('"element_id":"e1"');
      expect(modelToolContents[1]).toContain("windows=1");
      expect(screenshotImageSeen).toBe(true);
      expect(serverFailure).toBeUndefined();
      const mcpTools = runtime.runtime.session
        .getActiveToolNames()
        .filter((name) => name.startsWith("mcp__munimComputerUse__"));
      expect(mcpTools).toEqual([]);
      expect(runtime.runtime.session.getActiveToolNames()).toContain("munim_click");
      expect(runtime.runtime.session.getActiveToolNames()).toContain("munim_screenshot");
    } finally {
      await runtime?.dispose();
      server.closeAllConnections();
      server.close();
      await once(server, "close");
      await rm(root, { recursive: true, force: true });
    }
  });
});
