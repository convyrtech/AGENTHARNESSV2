import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, launchZenoApp, test, waitSettled } from "./fixtures.ts";

const packaged = process.env.PRSLOY_E2E_PACKAGED?.trim();
const munim = process.env.PRSLOY_MUNIM_BINARY?.trim();
const encryptedKey = process.env.PRSLOY_E2E_GATEWAY_ENCRYPTED_KEY?.trim();
const model = "deepseek-v4.1-flash-1017";
const upstream = "https://api.prsloy.online/v1/chat/completions";
const fixtureProject = fileURLToPath(
  new URL("./munim-autonomous-vision-fixture/MunimVisionFixture.csproj", import.meta.url),
);
const fixtureTitle = "PRSLOY 104 Munim Vision Fixture";
const bounds = { x: 2640, y: 80, width: 560, height: 300 };
const appBounds = { x: 2580, y: 500, width: 1000, height: 500 };
const maxUpstreamRequests = 6;
const maxRequestBytes = 2_000_000;

test("packaged PRSLOY lets live DeepSeek request and read a real Munim screenshot", async () => {
  test.skip(process.env.PRSLOY_E2E_LIVE_GATEWAY !== "1", "requires explicit paid gateway opt-in");
  test.skip(process.platform !== "win32", "requires Windows UI Automation");
  test.skip(
    !packaged || !munim || !encryptedKey,
    "requires packaged app, Munim, and local encrypted key",
  );
  test.setTimeout(300_000);

  const root = await mkdtemp(join(tmpdir(), "prsloy-munim-autonomous-vision-"));
  const workspace = join(root, "workspace");
  const userData = join(root, "electron-userData");
  const agentDir = join(root, "home", ".pi", "agent");
  const stateDir = join(userData, "prsloy");
  const fixtureBuild = join(root, "fixture-build");
  const published = join(fixtureBuild, "publish");
  const obj = join(fixtureBuild, "obj");
  const bin = join(fixtureBuild, "bin");
  const resultFile = join(root, "fixture-result.txt");
  const marker = `V${randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}`;
  const usageBefore = await readUsage();
  let fixture: ReturnType<typeof spawn> | undefined;
  let app: Awaited<ReturnType<typeof launchZenoApp>> | undefined;
  let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
  let completed = false;
  try {
    if (!insideDisplay2(bounds) || !insideDisplay2(appBounds) || !display2StillMatches())
      throw new Error("The isolated test windows do not fit the expected DISPLAY2");
    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(userData, { recursive: true }),
      mkdir(stateDir, { recursive: true }),
      mkdir(agentDir, { recursive: true }),
      mkdir(published, { recursive: true }),
    ]);
    await writeFile(join(workspace, "README.md"), "Synthetic Munim vision fixture.\n");
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ extensions: ["+builtin:mcp"] }),
    );
    await writeFile(
      join(userData, "zeno-desktop.json"),
      JSON.stringify({ recentWorkspaces: [], window: appBounds }),
    );
    const keyPath = resolve(encryptedKey!);
    const localState = join(dirname(keyPath), "electron-userdata", "Local State");
    await copyFile(keyPath, join(stateDir, "gateway-key.bin"));
    await copyFile(localState, join(userData, "Local State"));

    execFileSync(
      "dotnet",
      [
        "publish",
        fixtureProject,
        "--configuration",
        "Release",
        "--output",
        published,
        "--nologo",
        `-p:BaseOutputPath=${bin}${sep}`,
        `-p:BaseIntermediateOutputPath=${obj}${sep}`,
        `-p:MSBuildProjectExtensionsPath=${obj}${sep}`,
      ],
      { stdio: "pipe", windowsHide: true, timeout: 60_000 },
    );
    fixture = spawn(
      "dotnet",
      [
        join(published, "PrsloyMunimVisionFixture.dll"),
        marker,
        resultFile,
        String(bounds.x),
        String(bounds.y),
      ],
      { stdio: "ignore", windowsHide: true },
    );
    const fixturePid = fixture.pid;
    if (!fixturePid) throw new Error("Synthetic vision fixture did not start");
    const fixtureWindow = await waitForWindow(fixturePid, fixtureTitle);

    const key = decryptLocalKey(keyPath, localState);
    gateway = await startGateway(key, fixturePid);
    await writeFile(
      join(stateDir, "state.json"),
      JSON.stringify({
        baseUrl: gateway.baseUrl,
        models: { ids: [model], checkedAt: new Date().toISOString() },
      }),
    );

    app = await launchZenoApp({
      root,
      workspacePath: workspace,
      tools: "munim_list_apps,munim_screenshot",
      model: { provider: "prsloy", id: model },
      modelInput: ["text", "image"],
      env: {
        PRSLOY_COMPUTER_USE: "1",
        PRSLOY_MUNIM_BINARY: munim!,
        PRSLOY_CUA_BINARY: "",
        PRSLOY_BALANCE_WARN_RUB: "0",
        ZENO_NO_AUTO_RESUME: "1",
      },
    });
    const appPid = await app.app.evaluate(() => process.pid);
    const appWindow = await waitForWindow(appPid);
    const electronWindow = await app.app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const handle = window?.getNativeWindowHandle();
      return window && handle?.length
        ? { hwnd: Number(handle.readBigUInt64LE()), bounds: window.getBounds() }
        : undefined;
    });
    if (
      !electronWindow ||
      appWindow.hwnd !== electronWindow.hwnd ||
      !sameBounds(electronWindow.bounds, appBounds)
    )
      throw new Error("Packaged PRSLOY HWND/bounds preflight failed");
    gateway.validate = () => {
      try {
        const fixtureNow = readWindow(fixturePid, fixtureTitle);
        const appNow = readWindow(appPid);
        return Boolean(
          fixture &&
          fixture.exitCode === null &&
          fixture.signalCode === null &&
          fixtureNow.hwnd === fixtureWindow.hwnd &&
          appNow.hwnd === appWindow.hwnd &&
          insideDisplay2(fixtureNow) &&
          insideDisplay2(appNow),
        );
      } catch {
        return false;
      }
    };
    await app.page.waitForSelector('[data-testid="zeno-app"][data-bootstrap-ready="true"]', {
      timeout: 120_000,
    });
    const modelsPath = join(agentDir, "models.json");
    const registry = JSON.parse(await readFile(modelsPath, "utf8")) as {
      providers: Record<
        string,
        { baseUrl: string; models: Array<{ id: string; input: string[]; maxTokens: number }> }
      >;
    };
    const provider = registry.providers.prsloy;
    if (!provider) throw new Error("PRSLOY provider is absent from isolated registry");
    const modelEntry = provider.models.find((entry) => entry.id === model);
    if (!modelEntry) throw new Error("Live vision model is absent from isolated registry");
    expect(provider.baseUrl).toBe(gateway.baseUrl);
    modelEntry.input = ["text", "image"];
    modelEntry.maxTokens = 512;
    await writeFile(modelsPath, JSON.stringify(registry));
    await app.fakeModel.stop();

    const trust = app.page.getByTestId("project-trust-dialog-trust");
    if (await trust.isVisible().catch(() => false)) await trust.click();
    const runtime = app.page.getByTestId("runtime-snapshot").first();
    if (!/"runtimeId":\s*"([^"]+)"/u.test((await runtime.textContent().catch(() => "")) ?? "")) {
      await app.page.getByTestId("start-host").click({ force: true });
      await expect(runtime).toContainText("runtimeId", { timeout: 60_000 });
    }
    await expect(app.page.getByTestId("host-status").first()).toContainText(
      /Agent Host ready|Agent Host restarted|Agent settled|就绪/u,
      { timeout: 60_000 },
    );

    const prompt = `First call munim_list_apps. Confirm the only target is PID ${fixturePid} with one window. Then call munim_screenshot for that PID. Read the short code visible in pixels and reply with only that code. The code is not in accessibility text or this prompt.`;
    await app.page.getByTestId("prompt-input").fill(prompt);
    await app.page.getByTestId("send-prompt").click();
    await expect.poll(() => gateway!.requests, { timeout: 45_000 }).toBeGreaterThan(1);
    await expect
      .poll(() => gateway!.toolCalls.length, { timeout: 90_000 })
      .toBeGreaterThanOrEqual(2);
    expect(gateway.toolCalls).toHaveLength(2);
    expect(gateway.toolCalls[0]).toMatchObject({ name: "munim_list_apps" });
    expect(gateway.toolCalls[1]).toMatchObject({ name: "munim_screenshot", pid: fixturePid });
    await expect.poll(() => gateway!.imageCorrelated, { timeout: 60_000 }).toBe(true);
    await waitSettled(app.page);
    const answer = await app.page.getByTestId("markdown-content").last().innerText();
    expect(answer.trim()).toBe(marker);
    expect(gateway.toolCalls).toHaveLength(2);
    expect(gateway.imagesSent).toBe(1);
    expect(gateway.toolErrors).toEqual([]);
    completed = true;
  } finally {
    const usageAfter = await readUsage().catch(() => undefined);
    const evidence = gateway
      ? {
          completed,
          model,
          requests: gateway.requests,
          toolCalls: gateway.toolCalls,
          imagesSent: gateway.imagesSent,
          imageCorrelated: gateway.imageCorrelated,
          messageShapes: gateway.messageShapes,
          toolErrors: gateway.toolErrors,
          quotaDelta:
            usageAfter && usageBefore ? usageAfter.total_used - usageBefore.total_used : undefined,
          fixturePid: fixture?.pid,
          markerMatched: completed,
        }
      : { completed: false, setupFailed: true };
    await writeFile(
      test.info().outputPath("munim-autonomous-vision-evidence.json"),
      JSON.stringify(evidence, null, 2),
    );
    await app?.app.close().catch(() => undefined);
    await gateway?.close().catch(() => undefined);
    if (fixture && fixture.exitCode === null && fixture.signalCode === null) {
      const exited = onceExit(fixture);
      fixture.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    }
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

type VisionGateway = {
  baseUrl: string;
  requests: number;
  toolCalls: Array<{ id: string; name: string; pid: number }>;
  imagesSent: number;
  imageCorrelated: boolean;
  messageShapes: Array<
    Array<{ role?: string; contentType: string; partTypes: string[]; toolResultId?: boolean }>
  >;
  toolErrors: string[];
  validate?: () => boolean;
  close(): Promise<void>;
};
async function startGateway(key: string, pid: number): Promise<VisionGateway> {
  const state: VisionGateway = {
    baseUrl: "",
    requests: 0,
    toolCalls: [],
    imagesSent: 0,
    imageCorrelated: false,
    messageShapes: [],
    toolErrors: [],
    close: async () => undefined,
  };
  const server: Server = createServer((req, res) => {
    void (async () => {
      if (req.method === "GET" && req.url === "/v1/models") {
        json(res, 200, { data: [{ id: model }] });
        return;
      }
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        json(res, 404, { error: "not found" });
        return;
      }
      if (!state.validate?.()) {
        state.toolErrors.push("fixture_validation");
        json(res, 409, { error: "fixture validation failed" });
        return;
      }
      if (state.requests >= maxUpstreamRequests) {
        state.toolErrors.push("request_limit");
        json(res, 429, { error: "test request limit reached" });
        req.resume();
        return;
      }
      const contentLength = Number(req.headers["content-length"]);
      if (Number.isFinite(contentLength) && contentLength > maxRequestBytes) {
        state.toolErrors.push("request_too_large");
        json(res, 413, { error: "test request too large" });
        req.resume();
        return;
      }
      const buffers: Buffer[] = [];
      let requestBytes = 0;
      for await (const chunk of req) {
        const buffer = Buffer.from(chunk);
        requestBytes += buffer.byteLength;
        if (requestBytes > maxRequestBytes) continue;
        buffers.push(buffer);
      }
      if (requestBytes > maxRequestBytes) {
        state.toolErrors.push("request_too_large");
        json(res, 413, { error: "test request too large" });
        return;
      }
      const body = JSON.parse(Buffer.concat(buffers).toString("utf8")) as Record<string, unknown>;
      if (body.model !== model) {
        state.toolErrors.push("model_mismatch");
        json(res, 400, { error: "model mismatch" });
        return;
      }
      const tools = Array.isArray(body.tools)
        ? (body.tools as Array<{ function?: { name?: string } }>)
        : [];
      if (
        tools.length !== 2 ||
        tools[0]?.function?.name !== "munim_list_apps" ||
        tools[1]?.function?.name !== "munim_screenshot"
      ) {
        state.toolErrors.push("tool_allowlist");
        json(res, 400, { error: "only list_apps and screenshot are allowed" });
        return;
      }
      const messages = Array.isArray(body.messages)
        ? (body.messages as Array<{
            role?: string;
            tool_call_id?: string;
            content?: unknown;
            tool_calls?: unknown;
          }>)
        : [];
      state.messageShapes.push(
        messages.map((message) => ({
          ...(typeof message.role === "string" ? { role: message.role } : {}),
          contentType: Array.isArray(message.content) ? "array" : typeof message.content,
          partTypes: Array.isArray(message.content)
            ? message.content.map((part) =>
                part &&
                typeof part === "object" &&
                typeof (part as { type?: unknown }).type === "string"
                  ? (part as { type: string }).type
                  : "other",
              )
            : [],
          toolResultId: typeof message.tool_call_id === "string",
        })),
      );
      const screenshotCallIds = messages.flatMap((message) => {
        const calls = message.tool_calls;
        if (message.role !== "assistant" || !Array.isArray(calls)) return [];
        return (calls as Array<{ id?: string; function?: { name?: string } }>)
          .filter(
            (call) => call.function?.name === "munim_screenshot" && typeof call.id === "string",
          )
          .map((call) => call.id!);
      });
      const listCallIds = messages.flatMap((message) => {
        const calls = message.tool_calls;
        if (message.role !== "assistant" || !Array.isArray(calls)) return [];
        return (calls as Array<{ id?: string; function?: { name?: string } }>)
          .filter(
            (call) => call.function?.name === "munim_list_apps" && typeof call.id === "string",
          )
          .map((call) => call.id!);
      });
      let requestImageCount = 0;
      for (const [index, message] of messages.entries()) {
        const imageCount = imagePartCount(message.content);
        requestImageCount += imageCount;
        if (
          message.role === "tool" &&
          typeof message.tool_call_id === "string" &&
          screenshotCallIds.includes(message.tool_call_id)
        ) {
          const next = messages[index + 1];
          state.imageCorrelated = Boolean(
            next && next.role === "user" && hasAttachedScreenshot(next.content),
          );
        }
        if (
          message.role === "tool" &&
          typeof message.tool_call_id === "string" &&
          listCallIds.includes(message.tool_call_id)
        ) {
          const safeList = parseFixtureInventory(message.content, pid);
          if (!safeList) {
            state.toolErrors.push("fixture_list_validation");
            json(res, 409, { error: "fixture list validation failed" });
            return;
          }
          // Never forward other process names or window titles to the live model.
          message.content = safeList;
        }
        if (
          message.role === "tool" &&
          typeof message.content === "string" &&
          /error|failed/iu.test(message.content)
        )
          state.toolErrors.push("munim_tool_error");
      }
      if (!hasOnlyCorrelatedScreenshot(messages, state.toolCalls, pid)) {
        state.toolErrors.push("unrelated_image");
        json(res, 400, { error: "only the correlated Munim screenshot is allowed" });
        return;
      }
      state.imagesSent = requestImageCount;
      // Several inbound requests may finish reading concurrently; reserve the
      // upstream slot synchronously immediately before dispatch.
      if (state.requests >= maxUpstreamRequests) {
        state.toolErrors.push("request_limit");
        json(res, 429, { error: "test request limit reached" });
        return;
      }
      state.requests++;
      const response = await fetch(upstream, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok || !response.body) {
        state.toolErrors.push(`upstream_${response.status}`);
        json(res, 502, { error: "upstream failed" });
        return;
      }
      const responseBytes = Buffer.from(await response.arrayBuffer());
      if (responseBytes.length > 2_000_000) {
        state.toolErrors.push("response_too_large");
        json(res, 502, { error: "response too large" });
        return;
      }
      const parsed = parseToolStream(responseBytes);
      if (!parsed.ok) {
        state.toolErrors.push("invalid_upstream_stream");
        json(res, 502, { error: "upstream stream rejected" });
        return;
      }
      const calls = parsed.calls;
      if (calls.length) {
        if (
          calls.length !== 1 ||
          (calls[0]?.name !== "munim_list_apps" && calls[0]?.name !== "munim_screenshot") ||
          calls[0]?.pid !== pid ||
          (calls[0]?.name === "munim_screenshot" &&
            !state.toolCalls.some(
              (call) => call.id !== calls[0]?.id && call.name === "munim_list_apps",
            ))
        ) {
          state.toolErrors.push("tool_call_outside_fixture");
          json(res, 502, { error: "tool call outside isolated fixture" });
          return;
        }
        state.toolCalls.push(...calls);
      }
      res.writeHead(response.status, {
        "content-type": response.headers.get("content-type") ?? "text/event-stream",
        "cache-control": "no-store",
      });
      res.end(responseBytes);
    })().catch(() => {
      if (!res.headersSent) json(res, 502, { error: "gateway error" });
      else res.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Could not bind vision test gateway");
  state.baseUrl = `http://127.0.0.1:${address.port}/v1`;
  state.close = async () => {
    server.closeAllConnections();
    server.close();
    await new Promise<void>((resolve) => server.once("close", resolve));
  };
  return state;
}

function imagePartCount(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  return content.filter(
    (part) =>
      part &&
      typeof part === "object" &&
      ((part as { type?: string }).type === "image" ||
        (part as { type?: string }).type === "image_url"),
  ).length;
}

function hasAttachedScreenshot(content: unknown): boolean {
  if (!Array.isArray(content) || content.length !== 2) return false;
  const [caption, image] = content as Array<{ type?: unknown; text?: unknown }>;
  return (
    caption?.type === "text" &&
    caption.text === "Attached image(s) from tool result:" &&
    image?.type === "image_url"
  );
}

function parseFixtureInventory(content: unknown, pid: number): string | undefined {
  if (typeof content !== "string") return undefined;
  const rows = content
    .split(/\r?\n/u)
    .filter((line) => new RegExp(`(?:^|\\s)pid=${pid}(?:\\s|$)`, "u").test(line));
  if (rows.length !== 1 || !/(?:^|\s)windows=1(?:\s|$)/u.test(rows[0]!)) return undefined;
  return `${pid} (pid=${pid}) windows=1`;
}

type ParsedToolStream = {
  ok: boolean;
  calls: Array<{ id: string; name: string; pid: number }>;
};

function parseToolStream(bytes: Buffer): ParsedToolStream {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, calls: [] };
  }
  if (!text.endsWith("\n\n") && !text.endsWith("\r\n\r\n")) return { ok: false, calls: [] };
  text = text.replace(/\r\n/gu, "\n");
  if (text.includes("\r")) return { ok: false, calls: [] };

  const calls = new Map<number, { id?: string; name: string; args: string }>();
  let sawData = false;
  let sawDone = false;
  let sawChoice = false;
  let finishReason: string | undefined;
  for (const frame of text.split("\n\n")) {
    if (frame === "") continue;
    const lines = frame.split("\n");
    if (lines.every((line) => line.startsWith(":"))) continue;
    if (lines.length !== 1 || !lines[0]!.startsWith("data: ") || sawDone)
      return { ok: false, calls: [] };
    const data = lines[0]!.slice("data: ".length);
    if (data === "[DONE]") {
      if (!sawData) return { ok: false, calls: [] };
      sawDone = true;
      continue;
    }
    sawData = true;
    let event: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(data);
      if (!value || typeof value !== "object" || Array.isArray(value))
        return { ok: false, calls: [] };
      event = value as Record<string, unknown>;
    } catch {
      return { ok: false, calls: [] };
    }
    if (
      !event ||
      typeof event !== "object" ||
      event.object !== "chat.completion.chunk" ||
      !Array.isArray(event.choices)
    )
      return { ok: false, calls: [] };
    if (event.choices.length === 0) {
      if (event.usage === undefined || !event.usage || typeof event.usage !== "object")
        return { ok: false, calls: [] };
      continue;
    }
    if (event.choices.length !== 1) return { ok: false, calls: [] };
    const choiceValue: unknown = event.choices[0];
    if (!choiceValue || typeof choiceValue !== "object" || Array.isArray(choiceValue))
      return { ok: false, calls: [] };
    const choice = choiceValue as Record<string, unknown>;
    const deltaValue: unknown = choice.delta;
    if (
      choice.index !== 0 ||
      !deltaValue ||
      typeof deltaValue !== "object" ||
      Array.isArray(deltaValue) ||
      (choice.finish_reason !== null &&
        choice.finish_reason !== undefined &&
        (typeof choice.finish_reason !== "string" ||
          !["stop", "tool_calls", "length", "content_filter"].includes(choice.finish_reason)))
    )
      return { ok: false, calls: [] };
    const delta = deltaValue as Record<string, unknown>;
    if (
      Object.keys(delta).some((key) => !["role", "content", "tool_calls"].includes(key)) ||
      (delta.role !== undefined && delta.role !== "assistant") ||
      (delta.content !== undefined && typeof delta.content !== "string") ||
      (delta.tool_calls !== undefined && !Array.isArray(delta.tool_calls))
    )
      return { ok: false, calls: [] };
    sawChoice = true;
    if (typeof choice.finish_reason === "string") {
      if (finishReason && finishReason !== choice.finish_reason) return { ok: false, calls: [] };
      finishReason = choice.finish_reason;
    }
    for (const part of (delta.tool_calls as unknown[] | undefined) ?? []) {
      if (!part || typeof part !== "object" || Array.isArray(part)) return { ok: false, calls: [] };
      const toolPart = part as Record<string, unknown>;
      const index = toolPart.index ?? 0;
      if (
        !Number.isSafeInteger(index) ||
        index !== 0 ||
        (toolPart.type !== undefined && toolPart.type !== "function")
      )
        return { ok: false, calls: [] };
      const call = calls.get(index) ?? { name: "", args: "" };
      if (toolPart.id !== undefined) {
        if (typeof toolPart.id !== "string" || (call.id && call.id !== toolPart.id))
          return { ok: false, calls: [] };
        call.id = toolPart.id;
      }
      if (toolPart.function !== undefined) {
        if (
          !toolPart.function ||
          typeof toolPart.function !== "object" ||
          Array.isArray(toolPart.function)
        )
          return { ok: false, calls: [] };
        const fn = toolPart.function as Record<string, unknown>;
        if (Object.keys(fn).some((key) => !["name", "arguments"].includes(key)))
          return { ok: false, calls: [] };
        if (fn.name !== undefined) {
          if (typeof fn.name !== "string") return { ok: false, calls: [] };
          call.name += fn.name;
        }
        if (fn.arguments !== undefined) {
          if (typeof fn.arguments !== "string") return { ok: false, calls: [] };
          call.args += fn.arguments;
        }
      }
      calls.set(index, call);
    }
  }
  if (!sawData || !sawDone || !sawChoice || !finishReason) return { ok: false, calls: [] };
  if ((finishReason === "tool_calls") !== calls.size > 0) return { ok: false, calls: [] };
  const parsedCalls = [...calls.values()].map((call) => {
    let pid = -1;
    try {
      const args = JSON.parse(call.args) as { pid?: unknown };
      if (typeof args.pid === "number") pid = args.pid;
    } catch {}
    return { id: call.id ?? "", name: call.name, pid };
  });
  if (parsedCalls.some((call) => !call.id || !call.name || call.pid < 0))
    return { ok: false, calls: [] };
  return { ok: true, calls: parsedCalls };
}

function hasOnlyCorrelatedScreenshot(
  messages: Array<{
    role?: string;
    tool_call_id?: string;
    content?: unknown;
    tool_calls?: unknown;
  }>,
  registeredCalls: Array<{ id: string; name: string; pid: number }>,
  pid: number,
): boolean {
  const imageParts = messages.flatMap((message, messageIndex) =>
    Array.isArray(message.content)
      ? message.content.flatMap((part, partIndex) =>
          part &&
          typeof part === "object" &&
          ((part as { type?: unknown }).type === "image" ||
            (part as { type?: unknown }).type === "image_url")
            ? [{ messageIndex, partIndex, part: part as Record<string, unknown> }]
            : [],
        )
      : [],
  );
  if (imageParts.length === 0) return true;
  if (imageParts.length !== 1) return false;
  const image = imageParts[0]!;
  if (image.part.type !== "image_url" || image.partIndex !== 1) return false;
  const imageUrl = (image.part.image_url as { url?: unknown } | undefined)?.url;
  if (typeof imageUrl !== "string" || !/^data:image\/(?:png|jpeg|webp);base64,/u.test(imageUrl))
    return false;
  const content = messages[image.messageIndex]?.content;
  if (!hasAttachedScreenshot(content)) return false;
  const userIndex = image.messageIndex;
  const result = messages[userIndex - 1];
  const assistant = messages[userIndex - 2];
  if (result?.role !== "tool" || typeof result.tool_call_id !== "string") return false;
  if (assistant?.role !== "assistant" || !Array.isArray(assistant.tool_calls)) return false;
  const matchingCall = (
    assistant.tool_calls as Array<{ id?: string; function?: { name?: string } }>
  ).find((call) => call.id === result.tool_call_id && call.function?.name === "munim_screenshot");
  if (!matchingCall) return false;
  return registeredCalls.some(
    (call) => call.id === matchingCall.id && call.name === "munim_screenshot" && call.pid === pid,
  );
}

test("vision relay fails closed on unsupported streams and uncorrelated images", () => {
  const chunk = (event: unknown) => Buffer.from(`data: ${JSON.stringify(event)}\n\n`);
  const validText = Buffer.concat([
    chunk({
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }],
    }),
    chunk({
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    }),
    Buffer.from("data: [DONE]\n\n"),
  ]);
  expect(parseToolStream(validText).ok).toBe(true);
  expect(parseToolStream(Buffer.from("data: not-json\n\ndata: [DONE]\n\n")).ok).toBe(false);
  expect(
    parseToolStream(
      Buffer.concat([
        chunk({
          object: "chat.completion.chunk",
          choices: [
            { index: 0, delta: { content: "ok" }, finish_reason: "stop" },
            { index: 1, delta: { content: "unsupported" }, finish_reason: "stop" },
          ],
        }),
        Buffer.from("data: [DONE]\n\n"),
      ]),
    ).ok,
  ).toBe(false);

  const call = { id: "shot-1", name: "munim_screenshot", pid: 123 };
  const messages = [
    { role: "assistant", tool_calls: [{ id: call.id, function: { name: call.name } }] },
    { role: "tool", tool_call_id: call.id, content: "screenshot result" },
    {
      role: "user",
      content: [
        { type: "text", text: "Attached image(s) from tool result:" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
      ],
    },
  ];
  expect(hasOnlyCorrelatedScreenshot(messages, [call], call.pid)).toBe(true);
  expect(hasOnlyCorrelatedScreenshot(messages, [], call.pid)).toBe(false);
  expect(
    hasOnlyCorrelatedScreenshot(
      [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://x/y.png" } }] }],
      [call],
      call.pid,
    ),
  ).toBe(false);
});

function decryptLocalKey(keyPath: string, localState: string): string {
  const script =
    "import base64,json,sys,win32crypt; from cryptography.hazmat.primitives.ciphers.aead import AESGCM; s=json.load(open(sys.argv[1])); k=win32crypt.CryptUnprotectData(base64.b64decode(s['os_crypt']['encrypted_key'])[5:],None,None,None,0)[1]; b=open(sys.argv[2],'rb').read(); print(AESGCM(k).decrypt(b[3:15],b[15:],None).decode().strip())";
  return execFileSync("python", ["-c", script, localState, keyPath], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}
async function readUsage(): Promise<{ total_used: number }> {
  if (!encryptedKey) throw new Error("Missing encrypted test key");
  const keyPath = resolve(encryptedKey);
  const localState = join(dirname(keyPath), "electron-userdata", "Local State");
  const key = decryptLocalKey(keyPath, localState);
  const response = await fetch("https://prsloy.online/api/usage/token/", {
    headers: { authorization: `Bearer ${key}` },
  });
  if (!response.ok) throw new Error("Could not read test-key usage");
  const body = (await response.json()) as { data?: { total_used?: number } };
  if (typeof body.data?.total_used !== "number") throw new Error("Usage total is unavailable");
  return { total_used: body.data.total_used };
}
function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
function onceExit(proc: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve) => proc.once("exit", () => resolve()));
}
function insideDisplay2(b: { x: number; y: number; width: number; height: number }): boolean {
  return b.x >= 2560 && b.y >= 0 && b.x + b.width <= 4480 && b.y + b.height <= 1032;
}
function sameBounds(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
function display2StillMatches(): boolean {
  try {
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        String.raw`Add-Type -AssemblyName System.Windows.Forms; $s=@([System.Windows.Forms.Screen]::AllScreens|Where-Object {$_.DeviceName -eq '\\.\DISPLAY2' -and -not $_.Primary}); if($s.Count -ne 1 -or $s[0].Bounds.X -ne 2560 -or $s[0].Bounds.Width -ne 1920 -or $s[0].Bounds.Height -ne 1080){exit 1}`,
      ],
      { stdio: "ignore", windowsHide: true, timeout: 10_000 },
    );
    return true;
  } catch {
    return false;
  }
}
async function waitForWindow(
  pid: number,
  title?: string,
): Promise<{ pid: number; hwnd: number; x: number; y: number; width: number; height: number }> {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const value = readWindow(pid, title);
      if (value.hwnd && insideDisplay2(value)) return value;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Target window did not appear on DISPLAY2");
}
function readWindow(
  pid: number,
  title?: string,
): { pid: number; hwnd: number; x: number; y: number; width: number; height: number } {
  const titleLiteral = title === undefined ? "$null" : `'${title.replaceAll("'", "''")}'`;
  const csharp =
    "using System;using System.Collections.Generic;using System.Runtime.InteropServices;using System.Text;" +
    "public static class MunimVisionWindow{public delegate bool EnumProc(IntPtr h,IntPtr l);" +
    "[StructLayout(LayoutKind.Sequential)]public struct RECT{public int Left;public int Top;public int Right;public int Bottom;}" +
    '[DllImport("user32.dll")]public static extern bool EnumWindows(EnumProc cb,IntPtr l);' +
    '[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);' +
    '[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);' +
    '[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out RECT r);' +
    '[DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr h);}';
  const script =
    "$ErrorActionPreference='Stop';Add-Type -TypeDefinition '" +
    csharp +
    "';$target=[uint32]" +
    pid +
    ";$expected=" +
    titleLiteral +
    ";$rows=[System.Collections.Generic.List[object]]::new();" +
    "$cb=[MunimVisionWindow+EnumProc]{param([IntPtr]$h,[IntPtr]$l);[uint32]$p=0;[void][MunimVisionWindow]::GetWindowThreadProcessId($h,[ref]$p);" +
    "if($p -ne $target){return $true};$r=[MunimVisionWindow+RECT]::new();if(-not [MunimVisionWindow]::GetWindowRect($h,[ref]$r)){return $true};" +
    "$s=[System.Text.StringBuilder]::new(512);[void][MunimVisionWindow]::GetWindowText($h,$s,$s.Capacity);" +
    "$rows.Add([pscustomobject]@{hwnd=$h.ToInt64();pid=$p;title=$s.ToString();visible=[MunimVisionWindow]::IsWindowVisible($h);x=$r.Left;y=$r.Top;width=$r.Right-$r.Left;height=$r.Bottom-$r.Top});return $true};" +
    "[void][MunimVisionWindow]::EnumWindows($cb,[IntPtr]::Zero);$matches=@($rows.ToArray()|Where-Object{$_.visible -and ($null -eq $expected -or $_.title -ceq $expected)});" +
    "if($matches.Count -ne 1){throw 'expected one matching window'};$matches[0]|ConvertTo-Json -Compress -Depth 3";
  return JSON.parse(
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5_000,
    }).trim(),
  );
}
