import { createServer, request as httpRequest, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { startLiveMunimProxy, type LiveMunimProxy } from "../../e2e/live-munim-proxy";

const fixture = { pid: 4812, hwnd: 94120, title: "PRSLOY Munim Synthetic Fixture" };
const prompts = [
  "Turn 1: inspect only the synthetic fixture, type the exact test marker, then stop for owner recovery.",
  "Owner recovery confirmed after turn 1. Turn 2: re-read only the synthetic fixture, click Save test marker, then stop for owner recovery.",
  "Owner recovery confirmed after turn 2. Turn 3: inspect only the synthetic fixture and report saved status; do not act.",
] as const;
const marker = "PRSLOY-MUNIM-SYNTHETIC-42";
const auth = "Bearer test-secret-never-log";
const uuid = "7e8740e1-4fa5-4ff0-8a9c-62e75e19c130";
const editToken = `munim_v1.${uuid}.0`;
const saveToken = `munim_v1.${uuid}.1`;
const running: Array<() => Promise<void>> = [];

function event(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}
function sseTool(name: string, args: Record<string, unknown>, id = `call-${name}`): string {
  return `${event({ id: "completion-fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] })}${event({ id: "completion-fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}data: [DONE]\n\n`;
}
function sseFinal(content = "Done."): string {
  return `${event({ id: "completion-fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })}${event({ id: "completion-fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}data: [DONE]\n\n`;
}
function sseFinalUsage(completion = 1): string {
  return `${event({ id: "completion-fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}${event({ id: "completion-fixture", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 10, completion_tokens: completion, total_tokens: 10 + completion } })}data: [DONE]\n\n`;
}
function toolFromResponse(text: string): {
  id: string;
  name: string;
  args: Record<string, unknown>;
} {
  const frame = text.split(/\r?\n/u).find((line) => line.startsWith("data: "));
  if (!frame) throw new Error("proxy emitted no canonical SSE frame");
  const event = JSON.parse(frame.slice(6));
  const call = event.choices?.[0]?.delta?.tool_calls?.[0];
  if (!call || typeof call.id !== "string" || typeof call.function?.name !== "string")
    throw new Error("proxy emitted no canonical tool call");
  return { id: call.id, name: call.function.name, args: JSON.parse(call.function.arguments) };
}
async function mockUpstream(
  responder: (
    body: any,
    authHeader: string | undefined,
  ) => {
    body: string;
    status?: number;
    location?: string;
    onRequest?: (body: any) => void;
    wait?: Promise<void>;
  },
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const answer = responder(body, req.headers.authorization);
      answer.onRequest?.(body);
      await answer.wait;
      res.writeHead(answer.status ?? 200, {
        "content-type": "text/event-stream",
        ...(answer.location ? { location: answer.location } : {}),
      });
      res.end(answer.body);
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock upstream did not bind");
  return {
    url: `http://127.0.0.1:${address.port}/v1/chat/completions`,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
async function proxy(
  upstreamUrl: string,
  overrides: Partial<Parameters<typeof startLiveMunimProxy>[0]> = {},
  check: () => boolean | Promise<boolean> = () => true,
): Promise<LiveMunimProxy> {
  return startLiveMunimProxy({
    fixturePid: fixture.pid,
    fixtureHwnd: fixture.hwnd,
    fixtureTitle: fixture.title,
    syntheticPrompts: prompts,
    syntheticMarker: marker,
    allowedModel: "gpt-6.1-sol",
    upstreamUrl,
    validateFixtureTarget: check,
    ...overrides,
  });
}
function request(
  messages: unknown[] = [{ role: "user", content: prompts[0] }],
  extra: Record<string, unknown> = {},
) {
  return fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-6.1-sol", messages, max_completion_tokens: 32, ...extra }),
  });
}
let baseUrl = "";
afterEach(async () => {
  for (const close of running.splice(0)) await close();
});

describe("live Munim test proxy", () => {
  it("accepts only the exact provider URL for opt-in live mode and loopback mock URLs for tests", async () => {
    await expect(proxy("http://localhost:3210/v1/chat/completions")).rejects.toThrow(
      "unapproved upstream",
    );
    await expect(
      proxy("https://example.com/v1/chat/completions", { liveEnabled: true }),
    ).rejects.toThrow("unapproved upstream");
    await expect(proxy("https://api.prsloy.online/v1/chat/completions")).rejects.toThrow(
      "unapproved upstream",
    );
    const configOnly = await proxy("https://api.prsloy.online/v1/chat/completions", {
      liveEnabled: true,
      timeoutMs: 90_000,
    });
    await configOnly.close();
  });

  it("completes a sanitized list/state/type/read/click lifecycle with fresh opaque controls", async () => {
    const forwarded: any[] = [];
    let step = 0;
    const snapshots = [
      `${fixture.pid} (pid ${fixture.pid})\nmunim_v1.${uuid}.2 Text "Ready"\nEmail: private-fixture-note\n${editToken} Edit "Test text"\n${saveToken} Button "Save test marker"`,
      `${fixture.pid} (pid ${fixture.pid})\nmunim_v1.979e05d2-0c63-4a9c-a06f-bc805c28a776.2 Text "Ready"\nEmail: private-fixture-note\nmunim_v1.979e05d2-0c63-4a9c-a06f-bc805c28a776.0 Edit "Test text" = "${marker}"\nmunim_v1.979e05d2-0c63-4a9c-a06f-bc805c28a776.1 Button "Save test marker"`,
      `${fixture.pid} (pid ${fixture.pid})\nEmail: private-fixture-note\nmunim_v1.2e983ceb-1bc8-4492-93f4-01ac0a76e82d.0 Edit "Test text" = "${marker}"\nmunim_v1.2e983ceb-1bc8-4492-93f4-01ac0a76e82d.2 Text "Saved: ${marker}"\nmunim_v1.2e983ceb-1bc8-4492-93f4-01ac0a76e82d.1 Button "Save test marker"`,
    ];
    const plans = [
      ["munim_list_apps", {}],
      ["munim_get_app_state", { pid: fixture.pid }],
      ["munim_type_text", { pid: fixture.pid, element_token: editToken, text: marker }],
      ["munim_list_apps", {}],
      ["munim_get_app_state", { pid: fixture.pid }],
      [
        "munim_click",
        { pid: fixture.pid, element_token: "munim_v1.979e05d2-0c63-4a9c-a06f-bc805c28a776.1" },
      ],
      ["munim_list_apps", {}],
      ["munim_get_app_state", { pid: fixture.pid }],
    ] as const;
    const listResult = `Other private app [irrelevant] pid=999 windows=1\n${fixture.title} [fixture] pid=${fixture.pid} windows=1`;
    const results = [
      listResult,
      snapshots[0]!,
      "native result deliberately discarded",
      listResult,
      snapshots[1]!,
      "native result deliberately discarded",
      listResult,
      snapshots[2]!,
    ];
    const upstream = await mockUpstream((body) => {
      forwarded.push(body);
      if (step >= plans.length)
        return { body: sseFinal("The fixture reports the saved synthetic marker.") };
      const [name, args] = plans[step]!;
      const n = step++;
      return { body: sseTool(name, args, `call-${n}`) };
    });
    running.push(upstream.close);
    const proxyServer = await proxy(upstream.url, {}, () => true);
    running.push(() => proxyServer.close());
    baseUrl = proxyServer.baseUrl;
    const history: any[] = [{ role: "user", content: prompts[0] }];
    for (let i = 0; i < plans.length; i++) {
      const response = await request(history);
      expect(response.status).toBe(200);
      const responseText = await response.text();
      expect(responseText).toContain("[DONE]");
      expect(responseText).not.toContain(`call-${i}`);
      expect(responseText).not.toContain('"usage"');
      const { id, name, args } = toolFromResponse(responseText);
      history.push({
        role: "assistant",
        content: null,
        tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
      });
      history.push({ role: "tool", tool_call_id: id, content: results[i]! });
      if (i === 2 || i === 5) {
        const recovered = await request(history);
        expect(recovered.status).toBe(200);
        const recoveryText = await recovered.text();
        expect(recoveryText).toContain("Owner recovery is required");
        history.push({
          role: "assistant",
          content:
            "The action outcome is unknown. Owner recovery is required before the next synthetic turn.",
        });
        history.push({ role: "user", content: prompts[i === 2 ? 1 : 2] });
      }
    }
    const final = await request(history);
    expect(final.status).toBe(200);
    await final.text();
    expect(forwarded[0].messages).toEqual([
      { role: "system", content: expect.any(String) },
      { role: "user", content: prompts[0] },
    ]);
    expect(
      forwarded
        .at(-1)
        .messages.filter((m: any) => m.role === "user")
        .map((m: any) => m.content),
    ).toEqual(prompts);
    expect(forwarded.every((b) => !JSON.stringify(b.messages).includes(auth))).toBe(true);
    expect(
      forwarded.every((b) => !JSON.stringify(b.messages).includes("fixture result deliberately")),
    ).toBe(true);
    expect(
      forwarded.every((b) => !JSON.stringify(b.messages).includes("private-fixture-note")),
    ).toBe(true);
    expect(forwarded.every((b) => !JSON.stringify(b.messages).includes("Other private app"))).toBe(
      true,
    );
    expect(JSON.stringify(forwarded.at(-1).messages)).toContain("Status: Saved: " + marker);
    expect(JSON.stringify(forwarded.at(-1).messages)).not.toContain(
      "munim_v1.2e983ceb-1bc8-4492-93f4-01ac0a76e82d.2",
    );
    expect(proxyServer.evidence().imageUploads).toBe(0);
    expect(proxyServer.evidence().markerReadBack).toBe(true);
    expect(proxyServer.evidence().savedStatusReadBack).toBe(true);
    expect(proxyServer.evidence().toolCalls).toBe(8);
    expect(proxyServer.evidence().toolSequence).toEqual([
      "munim_list_apps",
      "munim_get_app_state",
      "munim_type_text",
      "munim_list_apps",
      "munim_get_app_state",
      "munim_click",
      "munim_list_apps",
      "munim_get_app_state",
    ]);
    expect(proxyServer.evidence().outputTokensReported).toBe(0);
    expect(proxyServer.evidence().usageUnavailableResponses).toBe(9);
  });

  it("rejects foreign context, images, raw tools, wrong PID, stale/wrong controls and text", async () => {
    let reached = 0;
    const up = await mockUpstream(() => {
      reached += 1;
      return { body: sseTool("munim_list_apps", {}) };
    });
    running.push(up.close);
    const px = await proxy(up.url);
    running.push(() => px.close());
    baseUrl = px.baseUrl;
    expect((await request([{ role: "user", content: "private unrelated data" }])).status).toBe(400);
    expect(
      (
        await request([
          {
            role: "user",
            content: [
              { type: "text", text: prompts[0] },
              { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
            ],
          },
        ])
      ).status,
    ).toBe(400);
    expect(reached).toBe(0);
    expect(
      (
        await request([
          { role: "user", content: prompts[0] },
          {
            role: "assistant",
            tool_calls: [
              {
                id: "raw",
                type: "function",
                function: { name: "mcp__munimComputerUse__click", arguments: "{}" },
              },
            ],
          },
        ])
      ).status,
    ).toBe(400);
  });

  it("requires the proxy recovery final and exactly the next configured owner turn", async () => {
    const state = `${fixture.pid} (pid ${fixture.pid})\nmunim_v1.${uuid}.2 Text "Ready"\nmunim_v1.${uuid}.0 Edit "Test text"\nmunim_v1.${uuid}.1 Button "Save test marker"`;
    const plans = [
      ["munim_list_apps", {}],
      ["munim_get_app_state", { pid: fixture.pid }],
      ["munim_type_text", { pid: fixture.pid, element_token: editToken, text: marker }],
      ["munim_list_apps", {}],
    ] as const;
    const results = [`Fixture [test] pid=${fixture.pid} windows=1`, state, "action result ignored"];
    let step = 0;
    const up = await mockUpstream(() => {
      const [name, args] = plans[step]!;
      return { body: sseTool(name, args, `recovery-${step++}`) };
    });
    running.push(up.close);
    const px = await proxy(up.url);
    running.push(() => px.close());
    baseUrl = px.baseUrl;
    const history: any[] = [{ role: "user", content: prompts[0] }];
    for (let i = 0; i < 3; i++) {
      const response = await request(history);
      expect(response.status).toBe(200);
      const { id, name, args } = toolFromResponse(await response.text());
      history.push({
        role: "assistant",
        content: null,
        tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
      });
      history.push({ role: "tool", tool_call_id: id, content: results[i]! });
    }
    const recovery = await request(history);
    expect(recovery.status).toBe(200);
    await recovery.text();
    history.push({
      role: "assistant",
      content:
        "The action outcome is unknown. Owner recovery is required before the next synthetic turn.",
    });
    expect((await request(history)).status).toBe(400);
    expect((await request([...history, { role: "user", content: prompts[2] }])).status).toBe(400);
    const validNextTurn = await request([...history, { role: "user", content: prompts[1] }]);
    expect(validNextTurn.status).toBe(200);
    expect(toolFromResponse(await validNextTurn.text()).name).toBe("munim_list_apps");
  });

  it("enforces request, outbound byte, token and concurrency budgets before forwarding", async () => {
    let entered = 0;
    let signalEntered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((r) => {
      signalEntered = r;
    });
    const wait = new Promise<void>((r) => {
      release = r;
    });
    const up = await mockUpstream(() => {
      entered++;
      signalEntered();
      return { body: sseFinal(), wait };
    });
    running.push(up.close);
    const px = await proxy(up.url, { maxRequests: 2 });
    running.push(() => px.close());
    baseUrl = px.baseUrl;
    const firstPromise = request();
    await reached;
    expect((await request()).status).toBe(429);
    release();
    expect((await firstPromise).status).toBe(200);
    expect(entered).toBe(1);
    expect(px.evidence().requests).toBe(1);
    expect(px.evidence().outboundBytes).toBeGreaterThan(0);
  });

  it("holds single-flight while a slow request body is arriving, including before recovery commits", async () => {
    let forwarded = 0;
    let step = 0;
    const plan = [
      ["munim_list_apps", {}],
      ["munim_get_app_state", { pid: fixture.pid }],
      ["munim_type_text", { pid: fixture.pid, element_token: editToken, text: marker }],
      ["munim_list_apps", {}],
    ] as const;
    const state = `${fixture.pid} (pid ${fixture.pid})\nmunim_v1.${uuid}.2 Text "Ready"\n${editToken} Edit "Test text"\n${saveToken} Button "Save test marker"`;
    const up = await mockUpstream(() => {
      forwarded++;
      const [name, args] = plan[step]!;
      return { body: sseTool(name, args, `slow-${step++}`) };
    });
    running.push(up.close);
    const px = await proxy(up.url);
    running.push(() => px.close());
    baseUrl = px.baseUrl;
    const history: any[] = [{ role: "user", content: prompts[0] }];
    for (const result of [
      `Fixture [test] pid=${fixture.pid} windows=1`,
      state,
      "synthetic action result discarded",
    ]) {
      const response = await request(history);
      expect(response.status).toBe(200);
      const { id, name, args } = toolFromResponse(await response.text());
      history.push({
        role: "assistant",
        content: null,
        tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
      });
      history.push({ role: "tool", tool_call_id: id, content: result });
    }
    expect(forwarded).toBe(3);
    const payload = JSON.stringify({
      model: "gpt-6.1-sol",
      messages: history,
      max_completion_tokens: 32,
    });
    const url = new URL(`${baseUrl}/chat/completions`);
    const slow = httpRequest(url, {
      method: "POST",
      headers: {
        authorization: auth,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      },
    });
    let slowStatus = 0;
    const slowResult = new Promise<void>((resolve, reject) => {
      slow.once("response", (response) => {
        slowStatus = response.statusCode ?? 0;
        response.resume();
        response.once("end", resolve);
      });
      slow.once("error", reject);
    });
    slow.write(payload.slice(0, 12));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await request(history)).status).toBe(429);
    expect(forwarded).toBe(3);
    slow.end(payload.slice(12));
    await slowResult;
    expect(slowStatus).toBe(200);
    expect(forwarded).toBe(3);
    history.push({
      role: "assistant",
      content:
        "The action outcome is unknown. Owner recovery is required before the next synthetic turn.",
    });
    history.push({ role: "user", content: prompts[1] });
    expect((await request(history)).status).toBe(200);
  });

  it("allows nine 512-token reservations within the aggregate cap, rejects request 13 and enforces a smaller aggregate cap", async () => {
    const up = await mockUpstream(() => ({ body: sseFinalUsage() }));
    running.push(up.close);
    const px = await proxy(up.url);
    running.push(() => px.close());
    baseUrl = px.baseUrl;
    const full = () =>
      request([{ role: "user", content: prompts[0] }], { max_completion_tokens: 512 });
    for (let i = 0; i < 9; i++) expect((await full()).status).toBe(200);
    expect(px.evidence().requests).toBe(9);

    const capped = await proxy(up.url, { maxRequests: 12, maxOutputTokens: 512 });
    running.push(() => capped.close());
    baseUrl = capped.baseUrl;
    for (let i = 0; i < 12; i++) expect((await full()).status).toBe(200);
    expect((await full()).status).toBe(429);
    expect(capped.evidence().requests).toBe(12);

    const aggregate = await proxy(up.url, {
      maxRequests: 12,
      maxOutputTokens: 512,
      maxTotalOutputTokens: 1024,
    });
    running.push(() => aggregate.close());
    baseUrl = aggregate.baseUrl;
    expect((await full()).status).toBe(200);
    expect((await full()).status).toBe(200);
    expect((await full()).status).toBe(429);
    expect(aggregate.evidence().requests).toBe(2);
  });

  it("reserves byte budget before upstream and aborts a timed-out local upstream", async () => {
    let reached = 0;
    const overBudget = await mockUpstream(() => {
      reached++;
      return { body: sseFinal() };
    });
    running.push(overBudget.close);
    const limited = await proxy(overBudget.url, { maxTotalOutboundBytes: 1 });
    running.push(() => limited.close());
    baseUrl = limited.baseUrl;
    expect((await request()).status).toBe(429);
    expect(reached).toBe(0);
    expect(limited.evidence().outboundBytes).toBe(0);

    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = await mockUpstream(() => ({ body: sseFinal(), wait }));
    running.push(slow.close);
    const timed = await proxy(slow.url, { timeoutMs: 30 });
    running.push(() => timed.close());
    baseUrl = timed.baseUrl;
    const pending = request();
    await new Promise((resolve) => setTimeout(resolve, 80));
    release();
    expect((await pending).status).toBe(502);
    expect(timed.evidence().rejected).toContain("upstream");
    expect(timed.evidence().upstreamFailures).toEqual([{ kind: "timeout" }]);
  });

  it("rejects wrong PID, stale token, wrong control, synthetic text mismatch and raw tool names", async () => {
    const cases = [
      ["munim_get_app_state", { pid: fixture.pid + 1 }],
      ["munim_type_text", { pid: fixture.pid, element_token: editToken, text: "real user text" }],
      ["munim_click", { pid: fixture.pid, element_token: editToken }],
      [
        "munim_type_text",
        {
          pid: fixture.pid,
          element_token: "munim_v1.8cfa49ca-1e08-4e91-8e86-12e1991da684.0",
          text: marker,
        },
      ],
      ["mcp__munimComputerUse__click", { pid: fixture.pid, element_token: saveToken }],
    ] as const;
    for (const [name, args] of cases) {
      const up = await mockUpstream(() => ({ body: sseTool(name, args as any) }));
      running.push(up.close);
      const px = await proxy(up.url);
      running.push(() => px.close());
      baseUrl = px.baseUrl;
      const response = await request();
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("rejected by the local SSE validator");
      expect(px.evidence().invalidSseDetails).toContain("invalid_tool");
    }
  });

  it("does not allow a control token from an older snapshot after a newer state read", async () => {
    const tokenA = `munim_v1.a1f011dd-9fa1-4c7b-8d7d-cc58b7945221.0`;
    const saveA = `munim_v1.a1f011dd-9fa1-4c7b-8d7d-cc58b7945221.1`;
    const tokenB = `munim_v1.b2f011dd-9fa1-4c7b-8d7d-cc58b7945221.0`;
    const saveB = `munim_v1.b2f011dd-9fa1-4c7b-8d7d-cc58b7945221.1`;
    const initial = `${fixture.pid} (pid ${fixture.pid})\nmunim_v1.${uuid}.2 Text "Ready"\n${editToken} Edit "Test text"\n${saveToken} Button "Save test marker"`;
    const stateA = `${fixture.pid} (pid ${fixture.pid})\nmunim_v1.a1f011dd-9fa1-4c7b-8d7d-cc58b7945221.2 Text "Ready"\n${tokenA} Edit "Test text"\n${saveA} Button "Save test marker"`;
    const stateB = `${fixture.pid} (pid ${fixture.pid})\nmunim_v1.b2f011dd-1bc8-4492-93f4-01ac0a76e82d.2 Text "Ready"\n${tokenB} Edit "Test text"\n${saveB} Button "Save test marker"`;
    const plans = [
      ["munim_list_apps", {}],
      ["munim_get_app_state", { pid: fixture.pid }],
      ["munim_type_text", { pid: fixture.pid, element_token: editToken, text: marker }],
      ["munim_list_apps", {}],
      ["munim_get_app_state", { pid: fixture.pid }],
      ["munim_get_app_state", { pid: fixture.pid }],
      ["munim_click", { pid: fixture.pid, element_token: saveA }],
    ] as const;
    const listResult = `Fixture [test] pid=${fixture.pid} windows=1`;
    const results = [listResult, initial, "ignored", listResult, stateA, stateB];
    let step = 0;
    const up = await mockUpstream(() => {
      const [name, args] = plans[step]!;
      return { body: sseTool(name, args, `stale-${step++}`) };
    });
    running.push(up.close);
    const px = await proxy(up.url);
    running.push(() => px.close());
    baseUrl = px.baseUrl;
    const history: any[] = [{ role: "user", content: prompts[0] }];
    for (let i = 0; i < plans.length - 1; i++) {
      const response = await request(history);
      expect(response.status).toBe(200);
      const responseText = await response.text();
      const { id, name, args } = toolFromResponse(responseText);
      history.push({
        role: "assistant",
        content: null,
        tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
      });
      history.push({ role: "tool", tool_call_id: id, content: results[i]! });
      if (i === 2) {
        const recovery = await request(history);
        expect(recovery.status).toBe(200);
        await recovery.text();
        history.push({
          role: "assistant",
          content:
            "The action outcome is unknown. Owner recovery is required before the next synthetic turn.",
        });
        history.push({ role: "user", content: prompts[1] });
      }
    }
    const stale = await request(history);
    expect(stale.status).toBe(200);
    expect(await stale.text()).toContain("rejected by the local SSE validator");
    expect(px.evidence().invalidSseDetails).toContain("invalid_tool");
    expect(px.evidence().toolCalls).toBe(6);
  });

  it("rejects malformed, partial, length, content_filter and alternate-field SSE", async () => {
    const badBodies = [
      'data: {"object":"chat.completion.chunk"}\n\n',
      `${event({ object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "length" }] })}data: [DONE]\n\n`,
      `${event({ object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "content_filter" }] })}data: [DONE]\n\n`,
      `${event({ object: "chat.completion.chunk", surprise: "untrusted", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}data: [DONE]\n\n`,
      `${event({ object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
    ];
    for (const body of badBodies) {
      const up = await mockUpstream(() => ({ body }));
      running.push(up.close);
      const px = await proxy(up.url);
      running.push(() => px.close());
      baseUrl = px.baseUrl;
      const response = await request();
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("rejected by the local SSE validator");
      expect(px.evidence().rejected).toContain("invalid_sse");
      expect(px.evidence().invalidSseDetails).toHaveLength(1);
    }
  });

  it("accepts bounded standard SSE metadata, null content/logprobs and token detail usage, then strips them", async () => {
    const metadata = { service_tier: "priority", system_fingerprint: "fp-safe-01" };
    const terminal = event({
      id: "provider-id",
      object: "chat.completion.chunk",
      ...metadata,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: null },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 1,
        total_tokens: 11,
        prompt_tokens_details: { cached_tokens: 4, audio_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 1, accepted_prediction_tokens: 0 },
      },
    });
    const up = await mockUpstream(() => ({ body: `${terminal}data: [DONE]\n\n` }));
    running.push(up.close);
    const px = await proxy(up.url);
    running.push(() => px.close());
    baseUrl = px.baseUrl;
    const response = await request();
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("[DONE]");
    for (const unsafeOrUpstreamField of [
      "service_tier",
      "system_fingerprint",
      "provider-id",
      "cached_tokens",
      "reasoning_tokens",
      "logprobs",
    ])
      expect(text).not.toContain(unsafeOrUpstreamField);
    expect(px.evidence().invalidSseDetails).toEqual([]);
    expect(px.evidence().outputTokensReported).toBe(1);
  });

  it("accepts an empty choices usage event after the terminal and ignores only exact model mismatches", async () => {
    let reached = 0;
    const body = `${event({ object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: "stop" }] })}${event({ object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3, prompt_tokens_details: { cached_tokens: 1 }, completion_tokens_details: { reasoning_tokens: 1 } } })}data: [DONE]\n\n`;
    const up = await mockUpstream(() => {
      reached++;
      return { body };
    });
    running.push(up.close);
    const px = await proxy(up.url);
    running.push(() => px.close());
    baseUrl = px.baseUrl;
    const mismatch = await request([{ role: "user", content: prompts[0] }], {
      model: "another-model",
    });
    expect(mismatch.status).toBe(200);
    expect(await mismatch.text()).toContain("model request was ignored");
    expect(px.evidence().ignoredModelRequests).toBe(1);
    expect(px.evidence().rejected).not.toContain("bad_context");
    expect(reached).toBe(0);
    const accepted = await request();
    expect(accepted.status).toBe(200);
    expect(await accepted.text()).toContain("[DONE]");
    expect(px.evidence().outputTokensReported).toBe(1);
    expect(reached).toBe(1);
  });

  it("treats intermediate usage:null chunks as absent before a validated final usage object", async () => {
    const body = [
      event({
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        usage: null,
      }),
      event({
        object: "chat.completion.chunk",
        choices: [
          { index: 0, delta: { content: "Synthetic check complete." }, finish_reason: null },
        ],
        usage: null,
      }),
      event({
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: null,
      }),
      event({
        object: "chat.completion.chunk",
        choices: [],
        usage: {
          prompt_tokens: 5,
          completion_tokens: 2,
          total_tokens: 7,
          prompt_tokens_details: null,
          completion_tokens_details: null,
        },
      }),
      "data: [DONE]\n\n",
    ].join("");
    const up = await mockUpstream(() => ({ body }));
    running.push(up.close);
    const px = await proxy(up.url);
    running.push(() => px.close());
    baseUrl = px.baseUrl;
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Synthetic check complete.");
    expect(px.evidence().invalidSseDetails).toEqual([]);
    expect(px.evidence().outputTokensReported).toBe(2);
    expect(px.evidence().usageUnavailableResponses).toBe(0);
  });

  it("reports fixed usage rejection categories without recording upstream values", async () => {
    const terminal = event({
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    });
    const validUsage = { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 };
    const terminalWithUsage = (usage: unknown) =>
      event({
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage,
      });
    const cases = [
      { chunks: [terminalWithUsage("private-usage-shape")], code: "usage_shape" },
      {
        chunks: [
          terminalWithUsage({ ...validUsage, private_usage_field: "private-unknown-value" }),
        ],
        code: "usage_unknown_fields",
      },
      {
        chunks: [
          terminalWithUsage({ ...validUsage, prompt_tokens_details: { private_detail: 1 } }),
        ],
        code: "usage_details",
      },
      {
        chunks: [terminalWithUsage({ ...validUsage, prompt_tokens: -1, total_tokens: 1 })],
        code: "usage_numbers",
      },
      { chunks: [terminalWithUsage({ ...validUsage, total_tokens: 8 })], code: "usage_sum" },
      {
        chunks: [
          terminalWithUsage(validUsage),
          event({ object: "chat.completion.chunk", choices: [], usage: validUsage }),
        ],
        code: "usage_duplicate",
      },
      {
        chunks: [
          event({
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: {}, finish_reason: null }],
            usage: validUsage,
          }),
        ],
        code: "usage_location",
      },
      {
        chunks: [event({ object: "chat.completion.chunk", choices: [], usage: validUsage })],
        code: "usage_location",
      },
      {
        chunks: [terminal, event({ object: "chat.completion.chunk", choices: [] })],
        code: "usage_missing",
      },
    ] as const;

    for (const { chunks, code } of cases) {
      const up = await mockUpstream(() => ({
        body: `${chunks.join("")}${terminal}data: [DONE]\n\n`,
      }));
      running.push(up.close);
      const px = await proxy(up.url);
      running.push(() => px.close());
      baseUrl = px.baseUrl;
      const response = await request();
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("rejected by the local SSE validator");
      expect(px.evidence().invalidSseDetails).toContain(code);
      expect(JSON.stringify(px.evidence())).not.toContain("private-usage-shape");
      expect(JSON.stringify(px.evidence())).not.toContain("private-unknown-value");
      expect(JSON.stringify(px.evidence())).not.toContain("private_detail");
    }
  });

  it("rejects malformed allowlisted metadata without exposing provider values", async () => {
    const valid = {
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    };
    const cases = [
      { chunk: { ...valid, service_tier: { secret: "tier-value" } }, code: "invalid_metadata" },
      { chunk: { ...valid, system_fingerprint: "x".repeat(129) }, code: "invalid_metadata" },
      {
        chunk: {
          ...valid,
          choices: [{ ...valid.choices[0], logprobs: { secret: "logprob-value" } }],
        },
        code: "invalid_choice",
      },
      {
        chunk: {
          ...valid,
          usage: {
            prompt_tokens: 1,
            completion_tokens: 0,
            total_tokens: 1,
            prompt_tokens_details: { private_field: 1 },
          },
        },
        code: "usage_details",
      },
    ] as const;
    for (const { chunk, code } of cases) {
      const up = await mockUpstream(() => ({ body: `${event(chunk)}data: [DONE]\n\n` }));
      running.push(up.close);
      const px = await proxy(up.url);
      running.push(() => px.close());
      baseUrl = px.baseUrl;
      const response = await request();
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain("rejected by the local SSE validator");
      expect(text).not.toContain("tier-value");
      expect(text).not.toContain("logprob-value");
      expect(px.evidence().invalidSseDetails).toContain(code);
    }
  });

  it("discards empty string content after tool start and reports only a fixed diagnostic", async () => {
    const body = [
      event({
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "provider-call",
                  type: "function",
                  function: { name: "munim_list_apps", arguments: "{}" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      event({
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content: "" }, finish_reason: null }],
      }),
      event({
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      }),
      "data: [DONE]\n\n",
    ].join("");
    const up = await mockUpstream(() => ({ body }));
    running.push(up.close);
    const px = await proxy(up.url);
    running.push(() => px.close());
    baseUrl = px.baseUrl;
    const response = await request();
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(toolFromResponse(text).name).toBe("munim_list_apps");
    expect(text).not.toContain("provider-call");
    expect(px.evidence().sseContentDiagnostics).toEqual(["content_after_tool_empty"]);
    expect(px.evidence().invalidSseDetails).toEqual([]);
  });

  it("uses fixed content diagnostics for unsafe post-tool, non-string, oversized and image-like content", async () => {
    const prefix = event({
      object: "chat.completion.chunk",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "provider-call",
                type: "function",
                function: { name: "munim_list_apps", arguments: "{}" },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
    const cases = [
      {
        chunks: [
          prefix,
          event({
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: { content: "private prose" }, finish_reason: null }],
          }),
        ],
        code: "content_after_tool_nonempty",
      },
      {
        chunks: [
          event({
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: { content: { private: "value" } }, finish_reason: null }],
          }),
        ],
        code: "content_nonstring",
      },
      {
        chunks: [
          event({
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: { content: "x".repeat(4001) }, finish_reason: null }],
          }),
        ],
        code: "content_too_long",
      },
      {
        chunks: [
          event({
            object: "chat.completion.chunk",
            choices: [
              {
                index: 0,
                delta: { content: `data:image/png;base64,${"a".repeat(32)}` },
                finish_reason: null,
              },
            ],
          }),
        ],
        code: "final_content_image_or_long",
      },
    ] as const;
    for (const { chunks, code } of cases) {
      const body = `${chunks.join("")}${event({ object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}data: [DONE]\n\n`;
      const up = await mockUpstream(() => ({ body }));
      running.push(up.close);
      const px = await proxy(up.url);
      running.push(() => px.close());
      baseUrl = px.baseUrl;
      const response = await request();
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("rejected by the local SSE validator");
      expect(px.evidence().invalidSseDetails).toContain(code);
      expect(px.evidence().toolCalls).toBe(0);
    }
  });

  it("accepts complete CRLF SSE and canonicalizes it", async () => {
    const up = await mockUpstream(() => ({ body: sseFinal().replace(/\n/gu, "\r\n") }));
    running.push(up.close);
    const px = await proxy(up.url);
    running.push(() => px.close());
    baseUrl = px.baseUrl;
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("[DONE]");
    expect(px.evidence().usageUnavailableResponses).toBe(1);
  });

  it("fails closed when the live fixture validation callback rejects and never returns a tool call", async () => {
    let reached = 0;
    let fixtureValid = false;
    const up = await mockUpstream(() => {
      reached++;
      return { body: sseTool("munim_list_apps", {}) };
    });
    running.push(up.close);
    const px = await proxy(up.url, {}, () => fixtureValid);
    running.push(() => px.close());
    baseUrl = px.baseUrl;
    const response = await request();
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain("munim_list_apps");
    expect(body).not.toContain("call-munim_list_apps");
    expect(px.evidence().rejected).toContain("fixture_unverified");
    expect(reached).toBe(0);
    expect(px.evidence().requests).toBe(0);
    fixtureValid = true;
    const retry = await request();
    expect(retry.status).toBe(200);
    expect(toolFromResponse(await retry.text()).name).toBe("munim_list_apps");
    expect(reached).toBe(1);
  });

  it("never records auth material or provider error bodies in evidence", async () => {
    const up = await mockUpstream(() => ({ status: 503, body: auth }));
    running.push(up.close);
    const px = await proxy(up.url);
    running.push(() => px.close());
    baseUrl = px.baseUrl;
    expect((await request()).status).toBe(502);
    expect(JSON.stringify(px.evidence())).not.toContain(auth);
    expect(px.evidence().upstreamFailures).toEqual([{ kind: "http_status", status: 503 }]);
  });

  it("records a no-body upstream failure without changing the gateway response", async () => {
    const up = await mockUpstream(() => ({ status: 204, body: "" }));
    running.push(up.close);
    const px = await proxy(up.url);
    running.push(() => px.close());
    baseUrl = px.baseUrl;
    expect((await request()).status).toBe(502);
    expect(px.evidence().upstreamFailures).toEqual([{ kind: "no_body" }]);
  });

  it("records a fixed URL mismatch diagnostic without retaining the upstream URL", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (new URL(url).hostname === "api.prsloy.online")
        return {
          ok: true,
          status: 200,
          url: "https://provider-redirect-secret.invalid/v1/chat/completions",
          body: null,
        } as Response;
      return originalFetch(input, init);
    }) as typeof fetch;
    try {
      const px = await proxy("https://api.prsloy.online/v1/chat/completions", {
        liveEnabled: true,
      });
      running.push(() => px.close());
      baseUrl = px.baseUrl;
      expect((await request()).status).toBe(502);
      expect(px.evidence().upstreamFailures).toEqual([{ kind: "url_mismatch" }]);
      expect(JSON.stringify(px.evidence())).not.toContain("provider-redirect-secret");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not follow upstream redirects", async () => {
    let redirected = 0;
    const destination = await mockUpstream(() => {
      redirected++;
      return { body: sseFinal() };
    });
    running.push(destination.close);
    const redirect = await mockUpstream(() => ({
      status: 302,
      location: destination.url,
      body: "redirect body",
    }));
    running.push(redirect.close);
    const px = await proxy(redirect.url);
    running.push(() => px.close());
    baseUrl = px.baseUrl;
    expect((await request()).status).toBe(502);
    expect(redirected).toBe(0);
    expect(px.evidence().upstreamFailures).toEqual([{ kind: "network" }]);
  });
});
