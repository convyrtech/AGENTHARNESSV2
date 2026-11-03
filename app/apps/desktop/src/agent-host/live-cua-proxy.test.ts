import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { startLiveCuaProxy } from "../../e2e/live-cua-proxy";

const fixture = { pid: 4120, hwnd: 78544, title: "PRSLOY 104 Packaged Cua Fixture" };
const prompt = "Run the isolated packaged CUA fixture flow.";
const auth = "Bearer never-log-this-test-secret";
const syntheticMarker = "PRSLOY-ISOLATED-MARKER-104";
const running: Array<() => Promise<void>> = [];

function sse(events: unknown[], appendTerminal = true): string {
  if (events.length === 0)
    events = [
      {
        id: "chatcmpl-empty",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      },
    ];
  if (
    appendTerminal &&
    !events.some((event: any) =>
      event?.choices?.some?.((choice: any) => choice?.finish_reason != null),
    )
  ) {
    const hasToolCall = events.some((event: any) =>
      event?.choices?.some?.(
        (choice: any) =>
          Array.isArray(choice?.delta?.tool_calls) && choice.delta.tool_calls.length > 0,
      ),
    );
    const terminal = {
      id: "chatcmpl-terminal",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: hasToolCall ? "tool_calls" : "stop" }],
    };
    const usageIndex = events.findIndex(
      (event: any) =>
        Array.isArray(event?.choices) && event.choices.length === 0 && event.usage !== undefined,
    );
    events.splice(usageIndex < 0 ? events.length : usageIndex, 0, terminal);
  }
  return `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
}
function toolDelta(name: string, args: string, index = 0): unknown {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            { index, id: "call_fixture", type: "function", function: { name, arguments: args } },
          ],
        },
        finish_reason: null,
      },
    ],
  };
}
function upstream(
  response: (
    body: any,
    authorization: string | undefined,
  ) => {
    status?: number;
    body: string;
    onRequest?: (body: any, authorization: string | undefined) => void;
  },
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      void (async () => {
        let raw = "";
        for await (const chunk of req) raw += String(chunk);
        let body: any;
        try {
          body = JSON.parse(raw);
        } catch {
          res.writeHead(400).end();
          return;
        }
        const result = response(body, req.headers.authorization);
        result.onRequest?.(body, req.headers.authorization);
        res.writeHead(result.status ?? 200, { "content-type": "text/event-stream" });
        res.end(result.body);
      })().catch(() => res.writeHead(500).end());
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("no local test port"));
      resolve({
        url: `http://127.0.0.1:${address.port}/v1/chat/completions`,
        close: () =>
          new Promise<void>((done, fail) =>
            server.close((error) => (error ? fail(error) : done())),
          ),
      });
    });
  });
}
async function setup(
  response: Parameters<typeof upstream>[0],
  proxyOptions: Record<string, unknown> = {},
) {
  const mock = await upstream(response);
  const proxy = await startLiveCuaProxy({
    fixturePid: fixture.pid,
    fixtureHwnd: fixture.hwnd,
    fixtureTitle: fixture.title,
    syntheticPrompt: prompt,
    allowedModel: "fixture-model",
    syntheticMarker,
    fixtureTextValues: [syntheticMarker, `Saved: ${syntheticMarker}`],
    validateFixtureTarget: () => true,
    upstreamUrl: mock.url,
    ...proxyOptions,
  } as any);
  running.push(async () => {
    await proxy.close();
    await mock.close();
  });
  return { mock, proxy };
}
function request(messages: unknown[], extras: Record<string, unknown> = {}) {
  return {
    model: "fixture-model",
    messages,
    max_tokens: 4096,
    max_completion_tokens: 4096,
    tools: [
      { type: "function", function: { name: "read", parameters: {} } },
      { type: "function", function: { name: "cua_list_apps", parameters: {} } },
      { type: "function", function: { name: "cua_list_windows", parameters: {} } },
    ],
    ...extras,
  };
}
async function post(baseUrl: string, body: unknown) {
  return fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
function fixtureSnapshot(generation = "sdeadbeef", value?: string, status = "Ready"): string {
  const editValue =
    value === undefined
      ? "id=fixtureInput actions=[set_value,text]"
      : `value="${value}" id=fixtureInput actions=[set_value,text]`;
  return [
    `window_id=${fixture.hwnd} pid=${fixture.pid} elements=8 snapshot_id=${generation}`,
    `element_token for row [N] = ${generation}:N (row [1] is "${generation}:1")`,
    "",
    `- Window "${fixture.title}"`,
    `  - Text "${status}"`,
    `  - [0] Edit "Test text" [${editValue}]`,
    `  - [1] Button "Save test marker" [id=fixtureSave actions=[invoke]]`,
    `  - [2] Button "Start delayed side effect" [id=fixtureDelayed actions=[invoke]]`,
    `  - [3] TitleBar [value="${fixture.title}" actions=[set_value]]`,
    `  - [4] MenuItem "Система" [actions=[expand]]`,
    `  - [5] Button "Свернуть" [actions=[invoke]]`,
    `  - [6] Button "Развернуть" [actions=[invoke]]`,
    `  - [7] Button "Закрыть" [actions=[invoke]]`,
  ].join("\n");
}
function stateMessages(generation = "sdeadbeef", value?: string, status = "Ready"): any[] {
  return [
    { role: "user", content: prompt },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_state",
          type: "function",
          function: {
            name: "cua_get_window_state",
            arguments: JSON.stringify({ pid: fixture.pid, window_id: fixture.hwnd }),
          },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call_state",
      content: fixtureSnapshot(generation, value, status),
    },
  ];
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((close) => close()));
});

describe("isolated live CUA proxy", () => {
  it("buffers fragmented SSE and blocks a late wrong HWND before forwarding any tool call", async () => {
    const { proxy } = await setup(() => ({
      body: sse([
        toolDelta(
          "cua_click",
          `{"pid":${fixture.pid},"window_id":${fixture.hwnd},"element_token":"sdeadbeef:1"`,
        ),
        toolDelta("", `,"window_id":999999}`),
      ]),
    }));
    const response = await post(proxy.baseUrl, request(stateMessages()));
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain("blocked an unsafe");
    expect(text).not.toContain("tool_calls");
    expect(proxy.evidence().toolNames).toEqual([]);
  });

  it("rejects a non-fixture PID/HWND model call before it reaches the host", async () => {
    const { proxy } = await setup(() => ({
      body: sse([
        toolDelta(
          "cua_get_window_state",
          JSON.stringify({ pid: fixture.pid + 1, window_id: fixture.hwnd }),
        ),
      ]),
    }));
    const response = await post(proxy.baseUrl, request([{ role: "user", content: prompt }]));
    expect(await response.text()).toContain("blocked an unsafe");
    expect(proxy.evidence().toolNames).toEqual([]);
  });

  it("passes a scoped fresh-token action and strips unapproved tool definitions and token limits", async () => {
    let outbound: any;
    let forwardedAuth: string | undefined;
    const { proxy } = await setup((_body, _authorization) => ({
      body: sse([
        toolDelta(
          "cua_click",
          JSON.stringify({
            pid: fixture.pid,
            window_id: fixture.hwnd,
            element_token: "sdeadbeef:1",
          }),
        ),
        {
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          choices: [],
          usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 },
        },
      ]),
      onRequest: (sent, sentAuth) => {
        outbound = sent;
        forwardedAuth = sentAuth;
      },
    }));
    const response = await post(proxy.baseUrl, request(stateMessages()));
    const text = await response.text();
    expect(text).toContain('"name":"cua_click"');
    expect(outbound.max_tokens).toBeUndefined();
    expect(outbound.max_completion_tokens).toBe(512);
    expect(outbound.tools.map((tool: any) => tool.function.name).sort()).toEqual(
      ["cua_click", "cua_get_window_state", "cua_list_windows", "cua_type_text"].sort(),
    );
    expect(
      outbound.tools.some((tool: any) =>
        ["read", "cua_list_apps", "bash"].includes(tool.function.name),
      ),
    ).toBe(false);
    expect(forwardedAuth).toBe(auth);
    expect(proxy.evidence()).toMatchObject({
      requestCount: 1,
      toolNames: ["cua_click"],
      usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 },
      imageForwarded: 0,
    });
    expect(proxy.evidence().outboundBytes).toBeGreaterThan(0);
    expect(JSON.stringify(proxy.evidence())).not.toContain(auth);
    expect(JSON.stringify(proxy.evidence())).not.toContain(prompt);
  });

  it("forwards one image only from the exact fixture-window snapshot", async () => {
    let outboundContent: any;
    const { proxy } = await setup(
      (_body) => ({
        body: sse([
          toolDelta(
            "cua_click",
            JSON.stringify({
              pid: fixture.pid,
              window_id: fixture.hwnd,
              element_token: "sdeadbeef:1",
            }),
          ),
        ]),
        onRequest: (sent) => {
          outboundContent = sent.messages.at(-1).content;
        },
      }),
      {
        allowImages: true,
        sanitizeImageForUpload: () => "data:image/png;base64,U0FGRQ==",
      },
    );
    const messages = stateMessages();
    messages[2] = {
      ...messages[2]!,
      content: [
        { type: "text", text: fixtureSnapshot() },
        { type: "image_url", image_url: { url: "data:image/png;base64,YQ==" } },
      ],
    };
    const response = await post(proxy.baseUrl, request(messages));
    expect(response.status).toBe(200);
    expect(outboundContent).toEqual([
      {
        type: "text",
        text: `window_id=${fixture.hwnd} pid=${fixture.pid} snapshot_id=sdeadbeef\n- Window "${fixture.title}"\n- Text "Ready"\n- [0] Edit "Test text" sdeadbeef:0\n- [1] Button "Save test marker" sdeadbeef:1`,
      },
      { type: "image_url", image_url: { url: "data:image/png;base64,U0FGRQ==" } },
    ]);
    expect(proxy.evidence().imageForwarded).toBe(1);
  });

  it("withholds screenshots by default and never serializes their bytes", async () => {
    let outbound = "";
    const { proxy } = await setup(() => ({
      body: sse([]),
      onRequest: (body) => {
        outbound = JSON.stringify(body);
      },
    }));
    const messages = stateMessages();
    messages[2] = {
      ...messages[2]!,
      content: [
        { type: "text", text: fixtureSnapshot() },
        { type: "image_url", image_url: { url: "data:image/png;base64,SECRETSCREENSHOT" } },
      ],
    };
    expect((await post(proxy.baseUrl, request(messages))).status).toBe(200);
    expect(outbound).not.toContain("data:image");
    expect(outbound).not.toContain("SECRETSCREENSHOT");
    expect(proxy.evidence().imageForwarded).toBe(0);
  });

  it("refuses image forwarding when no privacy sanitizer is configured", async () => {
    let upstreamCalls = 0;
    const { proxy } = await setup(
      () => {
        upstreamCalls += 1;
        return { body: sse([]) };
      },
      { allowImages: true },
    );
    const messages = stateMessages();
    messages[2] = {
      ...messages[2]!,
      content: [
        { type: "text", text: fixtureSnapshot() },
        { type: "image_url", image_url: { url: "data:image/png;base64,SECRETSCREENSHOT" } },
      ],
    };
    const response = await post(proxy.baseUrl, request(messages));
    expect(response.status).toBe(403);
    expect(upstreamCalls).toBe(0);
    expect(proxy.evidence().imageForwarded).toBe(0);
  });

  it("rechecks the fixture after image sanitization and denies a changed target", async () => {
    let upstreamCalls = 0;
    let sanitizerCalls = 0;
    let validationCalls = 0;
    const { proxy } = await setup(
      () => {
        upstreamCalls += 1;
        return { body: sse([]) };
      },
      {
        allowImages: true,
        sanitizeImageForUpload: () => {
          sanitizerCalls += 1;
          return "data:image/png;base64,U0FGRQ==";
        },
        validateFixtureTarget: () => {
          validationCalls += 1;
          return false;
        },
      },
    );
    const messages = stateMessages();
    messages[2] = {
      ...messages[2]!,
      content: [
        { type: "text", text: fixtureSnapshot() },
        { type: "image_url", image_url: { url: "data:image/png;base64,SECRETSCREENSHOT" } },
      ],
    };
    const response = await post(proxy.baseUrl, request(messages));
    expect(response.status).toBe(409);
    expect(sanitizerCalls).toBe(1);
    expect(validationCalls).toBe(1);
    expect(upstreamCalls).toBe(0);
    expect(proxy.evidence().imageForwarded).toBe(0);
  });

  it("forwards only the newest screenshot and flags an exact synthetic marker readback", async () => {
    let forwardedImages: string[] = [];
    let sanitizedInputs: string[] = [];
    let validationCalls = 0;
    const { proxy } = await setup(
      (_body) => ({
        body: sse([]),
        onRequest: (sent) => {
          forwardedImages = sent.messages.flatMap((message: any) =>
            Array.isArray(message.content)
              ? message.content
                  .filter((part: any) => part.type === "image_url")
                  .map((part: any) => part.image_url.url)
              : [],
          );
        },
      }),
      {
        allowImages: true,
        sanitizeImageForUpload: (image: string) => {
          sanitizedInputs.push(image);
          return "data:image/png;base64,U0FGRQ==";
        },
        validateFixtureTarget: () => {
          validationCalls += 1;
          return true;
        },
      },
    );
    const messages = [
      { role: "user", content: prompt },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "state_old",
            type: "function",
            function: {
              name: "cua_get_window_state",
              arguments: JSON.stringify({ pid: fixture.pid, window_id: fixture.hwnd }),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "state_old",
        content: [
          { type: "text", text: fixtureSnapshot("s11111111") },
          { type: "image_url", image_url: { url: "data:image/png;base64,YQ==" } },
        ],
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "state_new",
            type: "function",
            function: {
              name: "cua_get_window_state",
              arguments: JSON.stringify({ pid: fixture.pid, window_id: fixture.hwnd }),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "state_new",
        content: [
          { type: "text", text: fixtureSnapshot("s22222222", syntheticMarker) },
          { type: "image_url", image_url: { url: "data:image/png;base64,Yg==" } },
        ],
      },
    ];
    const response = await post(proxy.baseUrl, request(messages));
    expect(response.status).toBe(200);
    expect(sanitizedInputs).toEqual(["data:image/png;base64,Yg=="]);
    expect(forwardedImages).toEqual(["data:image/png;base64,U0FGRQ=="]);
    expect(validationCalls).toBe(1);
    expect(proxy.evidence()).toMatchObject({ imageForwarded: 1, markerReadBack: true });
    const noReadback = await setup(() => ({ body: sse([]) }));
    const plain = await post(noReadback.proxy.baseUrl, request(stateMessages()));
    expect(plain.status).toBe(200);
    expect(noReadback.proxy.evidence().markerReadBack).toBe(false);
  });

  it("allows only the role-specific fixture token and exact synthetic marker", async () => {
    const cases = [
      {
        name: "cua_type_text",
        args: {
          pid: fixture.pid,
          window_id: fixture.hwnd,
          element_token: "sdeadbeef:0",
          text: syntheticMarker,
        },
        allowed: true,
      },
      {
        name: "cua_type_text",
        args: {
          pid: fixture.pid,
          window_id: fixture.hwnd,
          element_token: "sdeadbeef:0",
          text: "PRIVATE TEXT",
        },
        allowed: false,
      },
      {
        name: "cua_click",
        args: { pid: fixture.pid, window_id: fixture.hwnd, element_token: "sdeadbeef:0" },
        allowed: false,
      },
      {
        name: "cua_click",
        args: { pid: fixture.pid, window_id: fixture.hwnd, element_token: "sdeadbeef:1" },
        allowed: true,
      },
    ];
    for (const item of cases) {
      const { proxy } = await setup(() => ({
        body: sse([toolDelta(item.name, JSON.stringify(item.args))]),
      }));
      const response = await post(proxy.baseUrl, request(stateMessages()));
      expect((await response.text()).includes("blocked an unsafe")).toBe(!item.allowed);
      expect(proxy.evidence().toolNames).toEqual(item.allowed ? [item.name] : []);
    }
    const delayed = stateMessages();
    const delayedProxy = await setup(() => ({
      body: sse([
        toolDelta(
          "cua_click",
          JSON.stringify({
            pid: fixture.pid,
            window_id: fixture.hwnd,
            element_token: "sdeadbeef:2",
          }),
        ),
      ]),
    }));
    expect((await post(delayedProxy.proxy.baseUrl, request(delayed))).status).toBe(200);
    expect(delayedProxy.proxy.evidence().toolNames).toEqual([]);
  });

  it("drops unrelated snapshot text, rejects unknown Edit values, and enforces model and tool_choice", async () => {
    let upstreamCalls = 0;
    let outbound: any;
    const { proxy } = await setup(() => {
      upstreamCalls += 1;
      return {
        body: sse([]),
        onRequest: (body) => {
          outbound = body;
        },
      };
    });
    const mixed = stateMessages();
    mixed[2] = {
      ...mixed[2]!,
      content: `${mixed[2]!.content}\nPrivate customer notes must never pass through.`,
    };
    expect((await post(proxy.baseUrl, request(mixed))).status).toBe(200);
    expect(JSON.stringify(outbound)).not.toContain("Private customer notes");
    expect(
      (await post(proxy.baseUrl, request(stateMessages("sdeadbeef", "PRIVATE EDIT VALUE")))).status,
    ).toBe(400);
    expect(
      (
        await post(
          proxy.baseUrl,
          request([{ role: "user", content: prompt }], { model: "other-model" }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await post(
          proxy.baseUrl,
          request([{ role: "user", content: prompt }], {
            tool_choice: { type: "function", function: { name: "cua_click" } },
          }),
        )
      ).status,
    ).toBe(400);
    expect(upstreamCalls).toBe(1);
  });

  it("preserves only Ready or the exact saved-marker status in sanitized snapshots", async () => {
    let outbound: any;
    const { proxy } = await setup(() => ({
      body: sse([]),
      onRequest: (body) => {
        outbound = body;
      },
    }));
    const ready = await post(
      proxy.baseUrl,
      request(stateMessages("sdeadbeef", undefined, "Ready")),
    );
    expect(ready.status).toBe(200);
    expect(outbound.messages.at(-1).content).toContain('- Text "Ready"');

    const saved = stateMessages("sdeadbeef", syntheticMarker, `Saved: ${syntheticMarker}`);
    expect((await post(proxy.baseUrl, request(saved))).status).toBe(200);
    expect(outbound.messages.at(-1).content).toContain(
      `- Text ${JSON.stringify(`Saved: ${syntheticMarker}`)}`,
    );
    expect(outbound.messages.at(-1).content).toContain(`value="${syntheticMarker}"`);

    const unknownStatus = stateMessages("sdeadbeef", syntheticMarker, "Saved: PRIVATE OTHER VALUE");
    expect((await post(proxy.baseUrl, request(unknownStatus))).status).toBe(400);
    expect(proxy.evidence().contextRejects).toEqual(["state_snapshot_rejected"]);
    expect(JSON.stringify(proxy.evidence())).not.toContain("PRIVATE OTHER VALUE");
  });

  it("rejects foreign windows in CUA context before making any upstream request", async () => {
    let calls = 0;
    const { proxy } = await setup(() => {
      calls += 1;
      return { body: sse([]) };
    });
    const messages = [
      { role: "user", content: prompt },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_list",
            type: "function",
            function: { name: "cua_list_windows", arguments: JSON.stringify({ pid: fixture.pid }) },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_list",
        content: JSON.stringify([
          { pid: fixture.pid, window_id: fixture.hwnd, title: fixture.title },
          { pid: 333, window_id: 444, title: "Other user window" },
        ]),
      },
    ];
    const response = await post(proxy.baseUrl, request(messages));
    expect(response.status).toBe(400);
    expect(calls).toBe(0);
    expect(proxy.evidence().requestCount).toBe(0);
  });

  it("accepts the actual Cua dotnet window-list line and rejects an additional foreign HWND", async () => {
    let outboundContent = "";
    const { proxy } = await setup((_body) => ({
      body: sse([]),
      onRequest: (body) => {
        outboundContent = body.messages.at(-1).content;
      },
    }));
    const list = (content: string) => [
      { role: "user", content: prompt },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "list_actual",
            type: "function",
            function: { name: "cua_list_windows", arguments: JSON.stringify({ pid: fixture.pid }) },
          },
        ],
      },
      { role: "tool", tool_call_id: "list_actual", content },
    ];
    const exact = `- dotnet.exe (pid ${fixture.pid}) "${fixture.title}" [window_id: ${fixture.hwnd}]`;
    expect((await post(proxy.baseUrl, request(list(exact)))).status).toBe(200);
    expect(outboundContent).toBe(
      JSON.stringify([{ pid: fixture.pid, window_id: fixture.hwnd, title: fixture.title }]),
    );
    const extra = `${exact}\n- dotnet.exe (pid 999) "Other window" [window_id: 888]`;
    expect((await post(proxy.baseUrl, request(list(extra)))).status).toBe(400);
  });

  it("invalidates every old element token after type_text before a later click", async () => {
    const history = [
      { role: "user", content: prompt },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "list_before",
            type: "function",
            function: { name: "cua_list_windows", arguments: JSON.stringify({ pid: fixture.pid }) },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "list_before",
        content: `- dotnet.exe (pid ${fixture.pid}) "${fixture.title}" [window_id: ${fixture.hwnd}]`,
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "state_before",
            type: "function",
            function: {
              name: "cua_get_window_state",
              arguments: JSON.stringify({ pid: fixture.pid, window_id: fixture.hwnd }),
            },
          },
        ],
      },
      { role: "tool", tool_call_id: "state_before", content: fixtureSnapshot() },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "type_done",
            type: "function",
            function: {
              name: "cua_type_text",
              arguments: JSON.stringify({
                pid: fixture.pid,
                window_id: fixture.hwnd,
                element_token: "sdeadbeef:0",
                text: syntheticMarker,
              }),
            },
          },
        ],
      },
      { role: "tool", tool_call_id: "type_done", content: "type result" },
    ];
    const { proxy } = await setup(() => ({
      body: sse([
        toolDelta(
          "cua_click",
          JSON.stringify({
            pid: fixture.pid,
            window_id: fixture.hwnd,
            element_token: "sdeadbeef:1",
          }),
        ),
      ]),
    }));
    const response = await post(proxy.baseUrl, request(history));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("blocked an unsafe");
    expect(proxy.evidence().toolNames).toEqual([]);
  });

  it("replaces Pi system/developer context and accepts only a single exact synthetic text block", async () => {
    let outbound: any;
    const { proxy } = await setup(() => ({
      body: sse([]),
      onRequest: (body) => {
        outbound = body;
      },
    }));
    const messages = [
      { role: "system", content: "PRIVATE SYSTEM PROMPT C:\\Users\\owner\\notes.txt" },
      { role: "developer", content: "PRIVATE DEVELOPER INSTRUCTIONS" },
      { role: "user", content: [{ type: "text", text: prompt }] },
    ];
    expect((await post(proxy.baseUrl, request(messages))).status).toBe(200);
    expect(outbound.messages).toEqual([
      { role: "system", content: expect.stringContaining("isolated packaged CUA test fixture") },
      { role: "user", content: prompt },
    ]);
    expect(JSON.stringify(outbound)).not.toContain("PRIVATE");
    expect(JSON.stringify(outbound)).not.toContain("C:\\\\Users");
  });

  it("drops assistant prose accompanying a synthetic tool call before rebuilding context", async () => {
    let outbound: any;
    const { proxy } = await setup(() => ({
      body: sse([]),
      onRequest: (body) => {
        outbound = body;
      },
    }));
    const messages = stateMessages();
    messages[1] = { ...messages[1], content: "Private generated narration must not be forwarded." };
    const response = await post(proxy.baseUrl, request(messages));
    expect(response.status).toBe(200);
    expect(outbound.messages[2]).toMatchObject({ role: "assistant", content: null });
    expect(JSON.stringify(outbound)).not.toContain("Private generated narration");
    expect(proxy.evidence().contextRejects).toEqual([]);
  });

  it("records only a fixed context-rejection code for rejected history", async () => {
    const { proxy } = await setup(() => ({ body: sse([]) }));
    const response = await post(
      proxy.baseUrl,
      request([{ role: "user", content: "PRIVATE NON-SYNTHETIC MESSAGE" }]),
    );
    expect(response.status).toBe(400);
    expect(proxy.evidence().contextRejects).toEqual(["synthetic_user_mismatch"]);
    expect(JSON.stringify(proxy.evidence())).not.toContain("PRIVATE NON-SYNTHETIC MESSAGE");
  });

  it("separates harmless wrong-model bootstrap requests from scenario context failures", async () => {
    let upstreamCalls = 0;
    const { proxy } = await setup(() => {
      upstreamCalls += 1;
      return { body: sse([]) };
    });
    const wrongModels = ["gpt-6.1-sol", "zeno-fake", "vendor-private-model"];
    for (const model of wrongModels) {
      const response = await post(
        proxy.baseUrl,
        request([{ role: "user", content: prompt }], { model }),
      );
      expect(response.status).toBe(400);
    }
    const requestWithoutModel = request([{ role: "user", content: prompt }]);
    delete (requestWithoutModel as Record<string, unknown>).model;
    expect((await post(proxy.baseUrl, requestWithoutModel)).status).toBe(400);
    expect(proxy.evidence().contextRejects).toEqual([]);
    expect(proxy.evidence().modelRejects).toEqual(["gpt-6.1-sol", "zeno-fake", "other", "absent"]);
    expect(JSON.stringify(proxy.evidence())).not.toContain("vendor-private-model");

    expect((await post(proxy.baseUrl, request([{ role: "user", content: prompt }]))).status).toBe(
      200,
    );
    expect(upstreamCalls).toBe(1);
    expect(proxy.evidence().contextRejects).toEqual([]);
  });

  it("drops Pi's exact attached-tool-image user message after the fixture state result", async () => {
    let outbound: any;
    const { proxy } = await setup(() => ({
      body: sse([]),
      onRequest: (body) => {
        outbound = body;
      },
    }));
    const messages = [
      ...stateMessages(),
      {
        role: "user",
        content: [
          { type: "text", text: "Attached image(s) from tool result:" },
          { type: "image_url", image_url: { url: "data:image/png;base64,YQ==" } },
        ],
      },
    ];
    const response = await post(proxy.baseUrl, request(messages));
    expect(response.status).toBe(200);
    expect(JSON.stringify(outbound.messages)).not.toContain("image_url");
    expect(JSON.stringify(outbound.messages)).not.toContain("YQ==");
    expect(proxy.evidence()).toMatchObject({ contextRejects: [], imageForwarded: 0 });
  });

  it("rejects Pi's attached-tool-image message before a fixture snapshot", async () => {
    const { proxy } = await setup(() => ({ body: sse([]) }));
    const response = await post(
      proxy.baseUrl,
      request([
        { role: "user", content: prompt },
        {
          role: "user",
          content: [
            { type: "text", text: "Attached image(s) from tool result:" },
            { type: "image_url", image_url: { url: "data:image/png;base64,YQ==" } },
          ],
        },
      ]),
    );
    expect(response.status).toBe(400);
    expect(proxy.evidence().contextRejects).toEqual(["synthetic_user_mismatch"]);
    expect(proxy.evidence().imageForwarded).toBe(0);
  });

  it("does not accept arbitrary auxiliary user text next to a fixture image", async () => {
    const { proxy } = await setup(() => ({ body: sse([]) }));
    const messages = [
      ...stateMessages(),
      {
        role: "user",
        content: [
          { type: "text", text: "PRIVATE USER TEXT" },
          { type: "image_url", image_url: { url: "data:image/png;base64,YQ==" } },
        ],
      },
    ];
    expect((await post(proxy.baseUrl, request(messages))).status).toBe(400);
    expect(proxy.evidence().contextRejects).toEqual(["synthetic_user_mismatch"]);
    expect(JSON.stringify(proxy.evidence())).not.toContain("PRIVATE USER TEXT");
  });

  it("drops one exact SDK image user after each validated CUA tool result", async () => {
    let outbound: any;
    const { proxy } = await setup(() => ({
      body: sse([]),
      onRequest: (body) => {
        outbound = body;
      },
    }));
    const attachedImage = () => ({
      role: "user",
      content: [
        { type: "text", text: "Attached image(s) from tool result:" },
        { type: "image_url", image_url: { url: "data:image/png;base64,YQ==" } },
      ],
    });
    const messages = [
      ...stateMessages(),
      attachedImage(),
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_type_text",
            type: "function",
            function: {
              name: "cua_type_text",
              arguments: JSON.stringify({
                pid: fixture.pid,
                window_id: fixture.hwnd,
                element_token: "sdeadbeef:0",
                text: syntheticMarker,
              }),
            },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_type_text", content: "Typed synthetic marker." },
      { role: "assistant", content: "I processed the tool result." },
      attachedImage(),
    ];
    const response = await post(proxy.baseUrl, request(messages));
    expect(response.status).toBe(200);
    expect(JSON.stringify(outbound.messages)).not.toContain("image_url");
    expect(JSON.stringify(outbound.messages)).not.toContain("YQ==");
    expect(JSON.stringify(outbound.messages)).not.toContain("Attached image(s)");
    expect(proxy.evidence()).toMatchObject({ contextRejects: [], imageForwarded: 0 });
  });

  it("rejects a second SDK auxiliary image without another tool result", async () => {
    const { proxy } = await setup(() => ({ body: sse([]) }));
    const attachedImage = () => ({
      role: "user",
      content: [
        { type: "text", text: "Attached image(s) from tool result:" },
        { type: "image_url", image_url: { url: "data:image/png;base64,YQ==" } },
      ],
    });
    const response = await post(
      proxy.baseUrl,
      request([...stateMessages(), attachedImage(), attachedImage()]),
    );
    expect(response.status).toBe(400);
    expect(proxy.evidence().contextRejects).toEqual(["synthetic_user_mismatch"]);
    expect(proxy.evidence().imageForwarded).toBe(0);
  });

  it("rejects orphaned, duplicated, or mismatched assistant tool results before upstream", async () => {
    let upstreamCalls = 0;
    const { proxy } = await setup(() => {
      upstreamCalls += 1;
      return { body: sse([]) };
    });
    const missing = stateMessages();
    missing.pop();
    const mismatched = stateMessages();
    mismatched[2] = { ...mismatched[2]!, tool_call_id: "different_call_id" };
    const duplicated = [...stateMessages(), stateMessages().at(-1)];
    for (const messages of [missing, mismatched, duplicated])
      expect((await post(proxy.baseUrl, request(messages))).status).toBe(400);
    expect(upstreamCalls).toBe(0);
  });

  it("rejects a missing list_windows PID and foreign HWND arguments", async () => {
    const { proxy } = await setup(() => ({ body: sse([toolDelta("cua_list_windows", "{}")]) }));
    const response = await post(proxy.baseUrl, request([{ role: "user", content: prompt }]));
    expect(await response.text()).toContain("blocked an unsafe");
    expect(proxy.evidence().toolNames).toEqual([]);
    expect(proxy.evidence().blockedActions).toEqual([
      { reason: "invalid_tool_arguments", toolName: "cua_list_windows" },
    ]);
  });

  it("rejects unknown, multiple, coordinate-based, and malformed tool calls", async () => {
    const responses = [
      sse([toolDelta("cua_list_apps", "{}")]),
      sse([
        toolDelta(
          "cua_click",
          JSON.stringify({
            pid: fixture.pid,
            window_id: fixture.hwnd,
            element_token: "sdeadbeef:1",
          }),
          0,
        ),
        toolDelta(
          "cua_type_text",
          JSON.stringify({
            pid: fixture.pid,
            window_id: fixture.hwnd,
            element_token: "sdeadbeef:1",
            text: "x",
          }),
          1,
        ),
      ]),
      sse([
        toolDelta(
          "cua_click",
          JSON.stringify({
            pid: fixture.pid,
            window_id: fixture.hwnd,
            element_token: "sdeadbeef:1",
            x: 12,
            y: 7,
          }),
        ),
      ]),
      sse([toolDelta("cua_click", "{not-json")]),
    ];
    const expectedBlocks = [
      { reason: "tool_not_allowed" },
      { reason: "invalid_upstream_sse", detail: "terminal_call_mismatch" },
      { reason: "invalid_tool_arguments", toolName: "cua_click" },
      { reason: "invalid_tool_arguments", toolName: "cua_click" },
    ];
    for (const [index, body] of responses.entries()) {
      const { proxy } = await setup(() => ({ body }));
      const response = await post(proxy.baseUrl, request(stateMessages()));
      expect(await response.text()).toContain("blocked an unsafe");
      expect(proxy.evidence().toolNames).toEqual([]);
      expect(proxy.evidence().blockedActions).toEqual([expectedBlocks[index]]);
      expect(JSON.stringify(proxy.evidence())).not.toContain(auth);
      expect(JSON.stringify(proxy.evidence())).not.toContain("not-json");
    }
  });

  it("fails closed on legacy function_call, message-shaped choices, nonzero indexes, extra choices, and post-DONE data", async () => {
    const completeToolCall = toolDelta("cua_list_windows", JSON.stringify({ pid: fixture.pid }));
    const responseBodies = [
      sse([
        {
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: { function_call: { name: "cua_list_windows", arguments: "{}" } },
              finish_reason: null,
            },
          ],
        },
      ]),
      sse([
        {
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          choices: [
            { index: 0, message: { role: "assistant", tool_calls: [] }, finish_reason: null },
          ],
        },
      ]),
      sse([
        {
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          choices: [{ index: 1, delta: { content: "hidden" }, finish_reason: null }],
        },
      ]),
      sse([
        {
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          choices: [
            { index: 0, delta: { content: "ok" }, finish_reason: null },
            { index: 1, delta: { content: "unsafe" }, finish_reason: null },
          ],
        },
      ]),
      `${sse([completeToolCall])}data: ${JSON.stringify({ id: "late", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "must-not-pass" }, finish_reason: null }] })}\n\n`,
    ];
    const expectedDetails = [
      "unexpected_delta_field",
      "invalid_choice_shape",
      "invalid_choice_index",
      "multiple_choices",
      "event_after_done",
    ];
    for (const [index, body] of responseBodies.entries()) {
      const { proxy } = await setup(() => ({ body }));
      const response = await post(proxy.baseUrl, request([{ role: "user", content: prompt }]));
      const text = await response.text();
      expect(text).toContain("blocked an unsafe");
      expect(text).not.toContain("must-not-pass");
      expect(proxy.evidence().toolNames).toEqual([]);
      expect(proxy.evidence().blockedActions).toEqual([
        { reason: "invalid_upstream_sse", detail: expectedDetails[index] },
      ]);
      expect(JSON.stringify(proxy.evidence())).not.toContain("hidden");
      expect(JSON.stringify(proxy.evidence())).not.toContain("unsafe");
    }
  });

  it("blocks tool calls on length or content_filter finish reasons", async () => {
    for (const finishReason of ["length", "content_filter"] as const) {
      const event = toolDelta("cua_list_windows", JSON.stringify({ pid: fixture.pid })) as any;
      event.choices[0].finish_reason = finishReason;
      const { proxy } = await setup(() => ({ body: sse([event], false) }));
      const response = await post(proxy.baseUrl, request([{ role: "user", content: prompt }]));
      const responseText = await response.text();
      expect(responseText).toContain("blocked an unsafe");
      expect(responseText).not.toContain('"name":"cua_list_windows"');
      expect(proxy.evidence().toolNames).toEqual([]);
      expect(proxy.evidence().blockedActions).toEqual([
        { reason: "invalid_upstream_sse", detail: "invalid_finish_reason" },
      ]);
    }
  });

  it("requires one consistent terminal reason and rejects output after it", async () => {
    const assistantChunk = {
      id: "terminal-test",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    };
    const terminal = (reason: string) => ({
      id: "terminal-test",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: reason }],
    });
    const toolCall = toolDelta("cua_list_windows", JSON.stringify({ pid: fixture.pid }));
    const contentAfterTerminal = {
      id: "terminal-test",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { content: "late content" }, finish_reason: null }],
    };
    const cases = [
      { events: [assistantChunk], expected: "missing_terminal" },
      {
        events: [assistantChunk, terminal("stop"), terminal("stop")],
        expected: "duplicate_terminal",
      },
      { events: [toolCall, terminal("stop")], expected: "terminal_call_mismatch" },
      { events: [assistantChunk, terminal("tool_calls")], expected: "terminal_call_mismatch" },
      {
        events: [assistantChunk, terminal("stop"), contentAfterTerminal],
        expected: "event_after_terminal",
      },
    ];
    for (const { events, expected } of cases) {
      const { proxy } = await setup(() => ({ body: sse(events, false) }));
      const response = await post(proxy.baseUrl, request([{ role: "user", content: prompt }]));
      const responseText = await response.text();
      expect(responseText).toContain("blocked an unsafe");
      expect(responseText).not.toContain("late content");
      expect(proxy.evidence().blockedActions).toEqual([
        { reason: "invalid_upstream_sse", detail: expected },
      ]);
    }
  });

  it("reports only fixed SSE rejection details for malformed and incomplete streams", async () => {
    const malformedChunk = JSON.stringify({
      id: "opaque-secret-id",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    });
    const bodies = [
      {
        body: `data: ${JSON.stringify("private raw content")}\n\ndata: [DONE]\n\n`,
        detail: "invalid_payload_shape",
      },
      { body: `data: {private raw content}\n\ndata: [DONE]\n\n`, detail: "invalid_json" },
      {
        body: `event: private-event\ndata: ${malformedChunk}\n\ndata: [DONE]\n\n`,
        detail: "malformed_frame",
      },
      { body: `data: [DONE]\n\n`, detail: "missing_event" },
      {
        body: `data: ${JSON.stringify({ ...JSON.parse(malformedChunk), choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: "stop" }] })}\n\n`,
        detail: "missing_done",
      },
      {
        body: `data: ${JSON.stringify({ ...JSON.parse(malformedChunk), provider: "private tier value" })}\n\ndata: [DONE]\n\n`,
        detail: "unknown_payload_field",
        sseField: "provider",
      },
      {
        body: `data: ${JSON.stringify({ ...JSON.parse(malformedChunk), "x-private-secret-key": "private extension value" })}\n\ndata: [DONE]\n\n`,
        detail: "unknown_payload_field",
        sseField: "other",
      },
    ];
    for (const { body, detail, sseField } of bodies) {
      const { proxy } = await setup(() => ({ body }));
      const response = await post(proxy.baseUrl, request([{ role: "user", content: prompt }]));
      expect(await response.text()).toContain("blocked an unsafe");
      expect(proxy.evidence().blockedActions).toEqual([
        { reason: "invalid_upstream_sse", detail, ...(sseField ? { sseField } : {}) },
      ]);
      const evidenceText = JSON.stringify(proxy.evidence());
      expect(evidenceText).not.toContain("private raw content");
      expect(evidenceText).not.toContain("opaque-secret-id");
      expect(evidenceText).not.toContain("private-event");
      expect(evidenceText).not.toContain("private tier value");
      expect(evidenceText).not.toContain("x-private-secret-key");
      expect(evidenceText).not.toContain("private extension value");
    }
  });

  it("accepts and strips only bounded service_tier metadata plus null logprobs/content", async () => {
    for (const serviceTier of [null, "priority"] as const) {
      const chunk = {
        id: "opaque-upstream-id",
        object: "chat.completion.chunk",
        service_tier: serviceTier,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: null },
            finish_reason: null,
            logprobs: null,
          },
        ],
      };
      const { proxy } = await setup(() => ({ body: sse([chunk]) }));
      const response = await post(proxy.baseUrl, request([{ role: "user", content: prompt }]));
      expect(response.status).toBe(200);
      const responseText = await response.text();
      expect(responseText).not.toContain("service_tier");
      expect(responseText).not.toContain("priority");
      expect(responseText).not.toContain("opaque-upstream-id");
      expect(proxy.evidence().blockedActions).toEqual([]);
    }
  });

  it("rejects service_tier outside null or a 64-character string and opaque logprobs", async () => {
    const validChunk = {
      id: "opaque-upstream-id",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    };
    const cases = [
      {
        event: { ...validChunk, service_tier: { raw: "opaque" } },
        detail: "invalid_service_tier",
        sseField: "service_tier",
      },
      {
        event: { ...validChunk, service_tier: "x".repeat(65) },
        detail: "invalid_service_tier",
        sseField: "service_tier",
      },
      {
        event: {
          ...validChunk,
          choices: [{ ...validChunk.choices[0]!, logprobs: { tokens: ["secret"] } }],
        },
        detail: "invalid_choice_logprobs",
      },
      {
        event: {
          ...validChunk,
          choices: [{ ...validChunk.choices[0]!, delta: { content: { secret: "no" } } }],
        },
        detail: "invalid_content",
      },
    ];
    for (const { event, detail, sseField } of cases) {
      const { proxy } = await setup(() => ({ body: sse([event]) }));
      const response = await post(proxy.baseUrl, request([{ role: "user", content: prompt }]));
      expect(await response.text()).toContain("blocked an unsafe");
      expect(proxy.evidence().blockedActions).toEqual([
        { reason: "invalid_upstream_sse", detail, ...(sseField ? { sseField } : {}) },
      ]);
      expect(JSON.stringify(proxy.evidence())).not.toContain("opaque");
      expect(JSON.stringify(proxy.evidence())).not.toContain("secret");
    }
  });

  it("rechecks the request cap atomically after concurrent request bodies are read", async () => {
    let upstreamCalls = 0;
    const { proxy } = await setup(
      () => {
        upstreamCalls += 1;
        return { body: sse([]) };
      },
      { maxRequests: 1 },
    );
    const results = await Promise.all([
      post(proxy.baseUrl, request([{ role: "user", content: prompt }])),
      post(proxy.baseUrl, request([{ role: "user", content: prompt }])),
    ]);
    expect(results.map((result) => result.status).sort((a, b) => a - b)).toEqual([200, 429]);
    expect(upstreamCalls).toBe(1);
    expect(proxy.evidence().requestCount).toBe(1);
  });

  it("rechecks fixture identity before exposing a validated model tool call", async () => {
    let checks = 0;
    const { proxy } = await setup(
      () => ({ body: sse([toolDelta("cua_list_windows", JSON.stringify({ pid: fixture.pid }))]) }),
      {
        validateFixtureTarget: () => {
          checks += 1;
          return false;
        },
      },
    );
    const response = await post(proxy.baseUrl, request([{ role: "user", content: prompt }]));
    expect(await response.text()).toContain("blocked an unsafe");
    expect(checks).toBe(1);
    expect(proxy.evidence().toolNames).toEqual([]);
    expect(proxy.evidence().blockedActions).toEqual([
      { reason: "fixture_unverified", toolName: "cua_list_windows" },
    ]);
    expect(JSON.stringify(proxy.evidence())).not.toContain(auth);
    expect(JSON.stringify(proxy.evidence())).not.toContain(fixture.title);
  });

  it("records callback exceptions as a fixed fixture-unverified code", async () => {
    const { proxy } = await setup(
      () => ({ body: sse([toolDelta("cua_list_windows", JSON.stringify({ pid: fixture.pid }))]) }),
      {
        validateFixtureTarget: () => {
          throw new Error("private target details");
        },
      },
    );
    const response = await post(proxy.baseUrl, request([{ role: "user", content: prompt }]));
    expect(await response.text()).toContain("blocked an unsafe");
    expect(proxy.evidence().blockedActions).toEqual([
      { reason: "fixture_unverified", toolName: "cua_list_windows" },
    ]);
    expect(JSON.stringify(proxy.evidence())).not.toContain("private target details");
  });

  it("enforces request-count and body-size limits", async () => {
    const { proxy } = await setup(() => ({ body: sse([]) }), { maxRequests: 1 });
    const first = await post(proxy.baseUrl, request([{ role: "user", content: prompt }]));
    expect(first.status).toBe(200);
    const second = await post(proxy.baseUrl, request([{ role: "user", content: prompt }]));
    expect(second.status).toBe(429);
    const bounded = await setup(() => ({ body: sse([]) }), { maxRequestBytes: 2_000 });
    const tooLarge = await post(bounded.proxy.baseUrl, {
      ...request([{ role: "user", content: prompt }]),
      unused: "x".repeat(3_000),
    });
    expect(tooLarge.status).toBe(400);
  });

  it("atomically reserves aggregate outbound bytes and screenshot uploads before concurrent fetches", async () => {
    let measuredBytes = 0;
    const measured = await setup(() => ({
      body: sse([]),
      onRequest: (body) => {
        measuredBytes = Buffer.byteLength(JSON.stringify(body));
      },
    }));
    const baseline = await post(
      measured.proxy.baseUrl,
      request([{ role: "user", content: prompt }]),
    );
    expect(baseline.status).toBe(200);
    expect(measured.proxy.evidence().outboundBytes).toBe(measuredBytes);
    await measured.proxy.close();
    await measured.mock.close();
    running.pop();

    let upstreamCalls = 0;
    const concurrent = await setup(
      () => {
        upstreamCalls += 1;
        return { body: sse([]) };
      },
      { maxTotalOutboundBytes: measuredBytes + 1 },
    );
    const results = await Promise.all([
      post(concurrent.proxy.baseUrl, request([{ role: "user", content: prompt }])),
      post(concurrent.proxy.baseUrl, request([{ role: "user", content: prompt }])),
    ]);
    expect(results.map((result) => result.status).sort((left, right) => left - right)).toEqual([
      200, 429,
    ]);
    expect(upstreamCalls).toBe(1);
    expect(concurrent.proxy.evidence().requestCount).toBe(1);
    expect(concurrent.proxy.evidence().outboundBytes).toBeLessThanOrEqual(measuredBytes + 1);

    let imageUpstreamCalls = 0;
    const imageLimit = await setup(
      () => {
        imageUpstreamCalls += 1;
        return { body: sse([]) };
      },
      {
        maxImageUploads: 0,
        allowImages: true,
        sanitizeImageForUpload: () => "data:image/png;base64,U0FGRQ==",
      },
    );
    const state = stateMessages();
    state[2] = {
      ...state[2]!,
      content: [
        { type: "text", text: fixtureSnapshot() },
        { type: "image_url", image_url: { url: "data:image/png;base64,YQ==" } },
      ],
    };
    const imageBlocked = await post(imageLimit.proxy.baseUrl, request(state));
    expect(imageBlocked.status).toBe(429);
    expect(imageUpstreamCalls).toBe(0);
    expect(imageLimit.proxy.evidence().imageForwarded).toBe(0);
  });

  it("refuses redirects and oversized buffered upstream responses", async () => {
    const redirect = await upstream(() => ({ status: 302, body: "moved" }));
    const proxyRedirect = await startLiveCuaProxy({
      fixturePid: fixture.pid,
      fixtureHwnd: fixture.hwnd,
      fixtureTitle: fixture.title,
      syntheticPrompt: prompt,
      allowedModel: "fixture-model",
      syntheticMarker,
      validateFixtureTarget: () => true,
      upstreamUrl: redirect.url,
    });
    running.push(async () => {
      await proxyRedirect.close();
      await redirect.close();
    });
    const response = await post(
      proxyRedirect.baseUrl,
      request([{ role: "user", content: prompt }]),
    );
    expect(response.status).toBe(502);

    const { proxy } = await setup(() => ({ body: `data: ${"x".repeat(4_000)}\n\n` }), {
      maxResponseBytes: 1_000,
    });
    const tooLarge = await post(proxy.baseUrl, request([{ role: "user", content: prompt }]));
    expect(tooLarge.status).toBe(502);
  });

  it("sanitizes list_windows to the exact fixture row and rejects malformed fixture output", async () => {
    let sent: any;
    const { proxy } = await setup((_body) => ({
      body: sse([]),
      onRequest: (value) => {
        sent = value;
      },
    }));
    const messages = [
      { role: "user", content: prompt },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_list",
            type: "function",
            function: { name: "cua_list_windows", arguments: JSON.stringify({ pid: fixture.pid }) },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_list",
        content: JSON.stringify([
          { pid: fixture.pid, window_id: fixture.hwnd, title: fixture.title },
        ]),
      },
    ];
    expect((await post(proxy.baseUrl, request(messages))).status).toBe(200);
    expect(sent.messages.at(-1).content).toBe(
      JSON.stringify([{ pid: fixture.pid, window_id: fixture.hwnd, title: fixture.title }]),
    );
  });
});
