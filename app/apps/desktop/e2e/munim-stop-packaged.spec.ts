import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { createServer, type Server } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { expect, launchZenoApp, test, waitSettled } from "./fixtures.ts";

const packaged = process.env.PRSLOY_E2E_PACKAGED?.trim();
const munim = process.env.PRSLOY_MUNIM_BINARY?.trim();
const fixtureProject = fileURLToPath(
  new URL("./munim-isolated-fixture/MunimIsolatedFixture.csproj", import.meta.url),
);
const fixtureTitle = "PRSLOY 104 Munim Isolated Fixture";
const display2 = { left: 2560, top: 0, right: 4480, bottom: 1032 };
const fixtureBounds = { x: 2640, y: 80, width: 560, height: 300 };
const appBounds = { x: 2580, y: 500, width: 1000, height: 500 };
type Bounds = { x: number; y: number; width: number; height: number };
type NativeWindow = Bounds & { hwnd: number; pid: number; title: string };
type WindowInventory = {
  visibleCount: number;
  matchingWindows: Array<NativeWindow & { visible: boolean }>;
};
type GatewayMessage = {
  role?: string;
  content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: string;
};
type ToolCall = { id?: string; function?: { name?: string } };
type RecoveryItem = {
  actionId: string;
  backend: string;
  pid: number;
  kind: string;
  status: string;
};

test("packaged PRSLOY Stop leaves a live Munim action unknown and blocks a repeat", async () => {
  test.skip(!packaged, "requires PRSLOY_E2E_PACKAGED pointing to a packaged Windows executable");
  test.skip(!munim, "requires PRSLOY_MUNIM_BINARY pointing to the verified real Munim executable");
  test.skip(process.platform !== "win32", "requires Windows UI Automation");
  test.setTimeout(180_000);
  assertInsideDisplay2(fixtureBounds);
  assertInsideDisplay2(appBounds);
  if (!display2StillMatches()) throw new Error("DISPLAY2 geometry changed before the test");
  const root = await mkdtemp(join(tmpdir(), "prsloy-munim-stop-packaged-"));
  const build = join(root, "fixture-build");
  const published = join(build, "publish");
  const obj = join(build, "obj");
  const bin = join(build, "bin");
  const fixtureOutput = join(root, "delayed-output.txt");
  const delayedStart = fixtureOutput + ".start";
  const delayedEnd = fixtureOutput + ".end";
  const delayedResult = fixtureOutput + ".delayed-result";
  const userData = join(root, "electron-userData");
  const workspace = join(root, "workspace");
  const fixtureDll = join(published, "PrsloyMunimIsolatedFixture.dll");
  let fixture: ReturnType<typeof spawn> | undefined;
  let launched: Awaited<ReturnType<typeof launchZenoApp>> | undefined;
  let gateway: StopMunimGateway | undefined;
  try {
    await mkdir(published, { recursive: true });
    await mkdir(userData, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(userData, "zeno-desktop.json"),
      JSON.stringify({ recentWorkspaces: [], window: appBounds }),
    );
    await writeFile(join(workspace, "README.md"), "Synthetic isolated Munim Stop fixture.\n");
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
        "-p:BaseOutputPath=" + bin + sep,
        "-p:BaseIntermediateOutputPath=" + obj + sep,
        "-p:MSBuildProjectExtensionsPath=" + obj + sep,
      ],
      { stdio: "pipe", windowsHide: true },
    );

    fixture = spawn(
      "dotnet",
      [fixtureDll, fixtureOutput, String(fixtureBounds.x), String(fixtureBounds.y)],
      {
        stdio: "ignore",
        windowsHide: true,
      },
    );
    const fixturePid = fixture.pid;
    if (!fixturePid) throw new Error("Munim delayed fixture did not start");
    const fixtureProcess = fixture;
    const initialFixtureWindow = await waitForExactWindow(fixturePid, fixtureTitle, fixtureBounds);
    let appPid = 0;
    let appHwnd = 0;
    gateway = await startStopMunimGateway({
      fixturePid,
      validateBeforeDispatch: async () => {
        if (!display2StillMatches()) return false;
        if (!launched || !appPid || !appHwnd) return false;
        if (fixtureProcess.exitCode !== null || fixtureProcess.signalCode !== null) return false;
        if ((await launched.app.evaluate(() => process.pid).catch(() => undefined)) !== appPid)
          return false;
        const currentFixture = await readExactWindow(fixturePid, fixtureTitle).catch(
          () => undefined,
        );
        if (
          !currentFixture ||
          currentFixture.hwnd !== initialFixtureWindow.hwnd ||
          !boundsEqual(currentFixture, fixtureBounds) ||
          !insideDisplay2(currentFixture)
        )
          return false;
        const currentApp = await readAppWindow(appPid).catch(() => undefined);
        const electronWindow = await launched.app.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows()[0];
          const handle = window?.getNativeWindowHandle();
          return window && handle?.length
            ? { hwnd: Number(handle.readBigUInt64LE()), bounds: window.getBounds() }
            : undefined;
        });
        return (
          currentApp !== undefined &&
          currentApp.hwnd === appHwnd &&
          insideDisplay2(currentApp) &&
          electronWindow?.hwnd === appHwnd &&
          electronWindow.bounds !== undefined &&
          boundsEqual(electronWindow.bounds, appBounds) &&
          insideDisplay2(electronWindow.bounds)
        );
      },
    });
    launched = await launchZenoApp({
      root,
      workspacePath: workspace,
      tools: "read,munim_list_apps,munim_get_app_state,munim_click",
      modelInput: ["text", "image"],
      modelBaseUrl: gateway.baseUrl,
      modelApiKey: "local-munim-stop-fixture-only",
      env: { PRSLOY_COMPUTER_USE: "1", PRSLOY_MUNIM_BINARY: munim!, PRSLOY_CUA_BINARY: "" },
    });
    const actualFixture = await readExactWindow(fixturePid, fixtureTitle);
    expect(actualFixture.hwnd).toBe(initialFixtureWindow.hwnd);
    expect(boundsEqual(actualFixture, fixtureBounds) && insideDisplay2(actualFixture)).toBe(true);
    appPid = await launched.app.evaluate(() => process.pid);
    if (!appPid) throw new Error("Packaged PRSLOY PID unavailable");
    const appWindow = await waitForAppWindow(launched, appPid);
    appHwnd = appWindow.hwnd;
    const mcp = JSON.parse(await readFile(join(launched.agentDir, "mcp.json"), "utf8")) as {
      mcpServers?: Record<string, { command?: string }>;
    };
    expect(mcp.mcpServers?.munimComputerUse?.command).toBe(munim);
    await launched.fakeModel.stop();
    const models = JSON.parse(await readFile(join(launched.agentDir, "models.json"), "utf8")) as {
      providers: Record<string, { baseUrl: string }>;
    };
    expect(models.providers["zeno-fake"]?.baseUrl).toBe(gateway.baseUrl);
    await launched.page.waitForSelector('[data-testid="zeno-app"][data-bootstrap-ready="true"]', {
      timeout: 120_000,
    });
    const runtime = launched.page.getByTestId("runtime-snapshot").first();
    if (!/"runtimeId":\s*"([^"]+)"/u.test((await runtime.textContent().catch(() => "")) ?? "")) {
      await launched.page.getByTestId("start-host").click({ force: true });
      await expect(runtime).toContainText("runtimeId", { timeout: 60_000 });
    }
    const trust = launched.page.getByTestId("project-trust-dialog-trust");
    if (await trust.isVisible().catch(() => false)) await trust.click();

    await sendPrompt(launched.page, "Start the delayed side effect once on the isolated fixture.");
    await expect.poll(() => gateway!.delayedClickIssued, { timeout: 60_000 }).toBe(true);
    await expect
      .poll(
        () =>
          readFile(delayedStart, "utf8")
            .then(() => true)
            .catch(() => false),
        { timeout: 30_000 },
      )
      .toBe(true);
    expect(await readFile(delayedEnd, "utf8").catch(() => undefined)).toBeUndefined();
    expect(await readFile(delayedResult, "utf8").catch(() => undefined)).toBeUndefined();
    const startMarkerAtStop = await readFile(delayedStart, "utf8");
    const pendingBeforeStop = await listRecovery(launched.page);
    expect(pendingBeforeStop).toHaveLength(1);
    expect(pendingBeforeStop[0]).toMatchObject({
      backend: "munim",
      pid: fixturePid,
      kind: "click",
    });
    expect(["dispatching", "unknown"]).toContain(pendingBeforeStop[0]!.status);

    await expect(launched.page.getByTestId("abort-prompt")).toBeVisible({ timeout: 10_000 });
    const modelRequestsAtStop = gateway.modelRequestCount;
    const clickRequestsAtStop = gateway.issuedClickRequests;
    await launched.page.getByTestId("abort-prompt").click({ force: true });
    await expect(launched.page.getByTestId("host-status").first()).toContainText(
      /Agent aborted|Agent settled/u,
      { timeout: 20_000 },
    );
    const pendingAfterStop = await waitForPendingRecovery(launched.page);
    expect(pendingAfterStop).toHaveLength(1);
    const stopActionId = pendingAfterStop[0]!.actionId;
    expect(pendingAfterStop[0]).toMatchObject({
      actionId: pendingBeforeStop[0]!.actionId,
      backend: "munim",
      pid: fixturePid,
      kind: "click",
    });
    expect(["dispatching", "unknown"]).toContain(pendingAfterStop[0]!.status);
    expect(await readFile(delayedStart, "utf8")).toBe(startMarkerAtStop);
    expect(await readFile(delayedEnd, "utf8").catch(() => undefined)).toBeUndefined();
    expect(await readFile(delayedResult, "utf8").catch(() => undefined)).toBeUndefined();

    await sendPrompt(
      launched.page,
      "Recovery gate probe: inspect and try the same delayed action once.",
    );
    await expect.poll(() => gateway!.repeatAttemptBlocked, { timeout: 60_000 }).toBe(true);
    await waitSettled(launched.page);
    const pendingAfterRepeat = await listRecovery(launched.page);
    expect(pendingAfterRepeat).toHaveLength(1);
    expect(pendingAfterRepeat[0]).toMatchObject({
      actionId: stopActionId,
      backend: "munim",
      pid: fixturePid,
      kind: "click",
    });
    expect(["dispatching", "unknown"]).toContain(pendingAfterRepeat[0]!.status);
    expect(gateway.issuedClickRequests).toBe(clickRequestsAtStop + 1);

    await expect
      .poll(
        () =>
          readFile(delayedEnd, "utf8")
            .then((value) => value.trim().length > 0)
            .catch(() => false),
        { timeout: 45_000, intervals: [200, 500, 1000] },
      )
      .toBe(true);
    expect(await readFile(delayedResult, "utf8")).toBe("completed");
    expect(await readFile(delayedStart, "utf8")).toBe(startMarkerAtStop);
    expect(gateway.issuedClickRequests).toBe(clickRequestsAtStop + 1);
    expect(gateway.repeatAttemptBlocked).toBe(true);
    expect(gateway.repeatBlockObservedBeforeRawDispatch).toBe(true);
    expect(gateway.topLevelRawToolsAbsent).toBe(true);
    const fixtureStartMarkerCount = (await readFile(delayedStart, "utf8"))
      .trim()
      .split(/\r?\n/u).length;
    const fixtureEndMarkerCount = (await readFile(delayedEnd, "utf8"))
      .trim()
      .split(/\r?\n/u).length;
    expect(fixtureStartMarkerCount).toBe(1);
    expect(fixtureEndMarkerCount).toBe(1);
    const finalPending = await listRecovery(launched.page);
    expect(finalPending).toMatchObject([
      {
        actionId: stopActionId,
        status: "unknown",
        backend: "munim",
        pid: fixturePid,
        kind: "click",
      },
    ]);

    const finalFixture = await readExactWindow(fixturePid, fixtureTitle);
    const finalApp = await readAppWindow(appPid);
    expect(finalFixture.hwnd).toBe(initialFixtureWindow.hwnd);
    expect(boundsEqual(finalFixture, fixtureBounds) && insideDisplay2(finalFixture)).toBe(true);
    expect(finalApp.hwnd).toBe(appWindow.hwnd);
    expect(insideDisplay2(finalApp)).toBe(true);
    await writeFile(
      test.info().outputPath("munim-stop-packaged-evidence.json"),
      JSON.stringify({
        modelGateway: "loopback scripted server",
        munimCommand: "real configured Munim executable",
        fixturePid,
        fixtureHwnd: finalFixture.hwnd,
        fixtureBounds: {
          x: finalFixture.x,
          y: finalFixture.y,
          width: finalFixture.width,
          height: finalFixture.height,
        },
        appPid,
        appHwnd: finalApp.hwnd,
        appBounds: { x: finalApp.x, y: finalApp.y, width: finalApp.width, height: finalApp.height },
        stopActionId,
        recoveryStatus: finalPending[0]?.status,
        issuedWrapperClickCalls: gateway.issuedClickRequests,
        repeatAttemptBlockedBeforeNestedDispatch: gateway.repeatBlockObservedBeforeRawDispatch,
        rawMunimActionCallCount: "not instrumented; this test does not claim a backend call count",
        fixtureStartMarkerCount,
        fixtureEndMarkerCount,
        delayedResult: "completed",
        modelRequestsAtStop,
        modelRequestsAfterStop: gateway.modelRequestCount - modelRequestsAtStop,
      }),
    );
  } finally {
    await launched?.app.close().catch(() => undefined);
    await launched?.fakeModel.stop().catch(() => undefined);
    await gateway?.close().catch(() => undefined);
    if (fixture) {
      const exited = once(fixture, "exit").catch(() => undefined);
      if (fixture.exitCode === null && fixture.signalCode === null) fixture.kill();
      if (fixture.exitCode === null && fixture.signalCode === null)
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    }
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

type StopMunimGateway = {
  baseUrl: string;
  modelRequestCount: number;
  issuedClickRequests: number;
  delayedClickIssued: boolean;
  repeatAttemptBlocked: boolean;
  repeatBlockObservedBeforeRawDispatch: boolean;
  topLevelRawToolsAbsent: boolean;
  close(): Promise<void>;
};
async function startStopMunimGateway(options: {
  fixturePid: number;
  validateBeforeDispatch: () => Promise<boolean>;
}): Promise<StopMunimGateway> {
  const gateway: StopMunimGateway = {
    baseUrl: "",
    modelRequestCount: 0,
    issuedClickRequests: 0,
    delayedClickIssued: false,
    repeatAttemptBlocked: false,
    repeatBlockObservedBeforeRawDispatch: false,
    topLevelRawToolsAbsent: true,
    close: async () => undefined,
  };
  let phase: "initial" | "repeat" = "initial";
  const server: Server = createServer((req, res) => {
    void (async () => {
      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "zeno-fake" }] }));
        return;
      }
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404).end();
        return;
      }
      gateway.modelRequestCount += 1;
      let raw = "";
      for await (const chunk of req) raw += String(chunk);
      const body = JSON.parse(raw) as {
        messages?: GatewayMessage[];
        tools?: Array<{ function?: { name?: string } }>;
      };
      const messages = body.messages ?? [];
      const tools = body.tools ?? [];
      const results = messages.filter((message) => message.role === "tool");
      const resultText = textOf(results.at(-1)?.content);
      const toolName = findLastToolCall(messages)?.function?.name ?? "";
      const latestUser =
        messages
          .filter((message) => message.role === "user")
          .map((message) => textOf(message.content))
          .at(-1) ?? "";
      gateway.topLevelRawToolsAbsent =
        gateway.topLevelRawToolsAbsent &&
        !tools.some((tool) => (tool.function?.name ?? "").startsWith("mcp__munimComputerUse__"));
      if (latestUser.includes("Recovery gate probe:") && phase !== "repeat") {
        phase = "repeat";
        await respond(res, wrapper("munim_list_apps", {}), results.length);
        return;
      }
      if (phase === "initial") {
        if (!toolName) {
          await respond(res, wrapper("munim_list_apps", {}), results.length);
          return;
        }
        if (toolName === "munim_list_apps") {
          assertFixtureListed(resultText, options.fixturePid);
          await respond(
            res,
            wrapper("munim_get_app_state", { pid: options.fixturePid }),
            results.length,
          );
          return;
        }
        if (toolName === "munim_get_app_state") {
          const token = tokenForLabel(resultText, /Start delayed side effect/iu);
          if (!(await options.validateBeforeDispatch()))
            throw new Error("PID/HWND/bounds preflight failed before delayed click");
          gateway.delayedClickIssued = true;
          gateway.issuedClickRequests += 1;
          await respond(
            res,
            wrapper("munim_click", { pid: options.fixturePid, element_token: token }),
            results.length,
          );
          return;
        }
        // The Stop request cancels the first turn; no follow-up action is scripted here.
        await respond(res, undefined, results.length);
        return;
      }
      if (toolName === "munim_list_apps") {
        assertFixtureListed(resultText, options.fixturePid);
        await respond(
          res,
          wrapper("munim_get_app_state", { pid: options.fixturePid }),
          results.length,
        );
        return;
      }
      if (toolName === "munim_get_app_state") {
        const token = tokenForLabel(resultText, /Start delayed side effect/iu);
        if (!(await options.validateBeforeDispatch()))
          throw new Error("PID/HWND/bounds preflight failed before repeat attempt");
        gateway.issuedClickRequests += 1;
        await respond(
          res,
          wrapper("munim_click", { pid: options.fixturePid, element_token: token }),
          results.length,
        );
        return;
      }
      if (toolName === "munim_click") {
        gateway.repeatAttemptBlocked = /CUA_RECOVERY_BLOCKED/u.test(resultText);
        gateway.repeatBlockObservedBeforeRawDispatch =
          gateway.repeatAttemptBlocked &&
          /Munim не вызван|Munim was not called|не вызван/iu.test(resultText);
        if (!gateway.repeatAttemptBlocked)
          throw new Error("Durable recovery gate did not reject repeat action: " + resultText);
        await respond(res, undefined, results.length);
        return;
      }
      await respond(res, undefined, results.length);
    })().catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : "gateway error" }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("loopback model gateway bind failed");
  gateway.baseUrl = "http://127.0.0.1:" + address.port + "/v1";
  gateway.close = async () => {
    server.closeAllConnections();
    server.close();
    await new Promise<void>((resolve) => server.once("close", resolve));
  };
  return gateway;
}
async function respond(
  res: import("node:http").ServerResponse,
  call: { name: string; args: Record<string, unknown> } | undefined,
  step: number,
): Promise<void> {
  const id = "munim-stop-" + step + "-" + Date.now();
  const message = call
    ? {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            index: 0,
            id: id + "-call",
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          },
        ],
      }
    : { role: "assistant", content: "Action state checked; no retry requested." };
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (delta: Record<string, unknown>, finish: string | null = null) =>
    res.write(
      "data: " +
        JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "zeno-fake",
          choices: [{ index: 0, delta, finish_reason: finish }],
        }) +
        "\n\n",
    );
  send({ role: "assistant" });
  if (call) send({ tool_calls: message.tool_calls });
  else send({ content: message.content });
  send({}, call ? "tool_calls" : "stop");
  res.end("data: [DONE]\n\n");
}
function wrapper(name: string, args: Record<string, unknown>) {
  return { name, args };
}
function assertFixtureListed(text: string, pid: number): void {
  if (!new RegExp("pid=" + pid + "(?:\\s|$)", "u").test(text) || !/windows=1/u.test(text))
    throw new Error("Munim did not report fixture PID with windows=1");
}
function findLastToolCall(messages: GatewayMessage[]): ToolCall | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === "assistant" && Array.isArray(message.tool_calls))
      return (message.tool_calls as ToolCall[]).at(-1);
  }
  return undefined;
}
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .join("\n");
}
function tokenForLabel(snapshot: string, label: RegExp): string {
  const tokens = snapshot
    .split(/\r?\n/u)
    .filter((line) => label.test(line))
    .map((line) => line.match(/munim_v1\.[0-9a-f-]{36}\.\d+/u)?.[0])
    .filter((token): token is string => token !== undefined);
  if (tokens.length !== 1)
    throw new Error("Munim snapshot did not expose one delayed-control token");
  return tokens[0]!;
}
async function sendPrompt(page: import("playwright").Page, prompt: string): Promise<void> {
  await page.getByTestId("prompt-input").fill(prompt);
  await page.getByTestId("send-prompt").click();
}
async function listRecovery(page: import("playwright").Page): Promise<RecoveryItem[]> {
  return page.evaluate(() => window.zeno.prsloy.cuaRecovery.list()) as Promise<RecoveryItem[]>;
}
async function waitForPendingRecovery(page: import("playwright").Page): Promise<RecoveryItem[]> {
  await expect.poll(async () => (await listRecovery(page)).length, { timeout: 15_000 }).toBe(1);
  return listRecovery(page);
}

async function waitForExactWindow(
  pid: number,
  title: string,
  expected: Bounds,
): Promise<NativeWindow> {
  let last: WindowInventory | undefined;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    last = await readProcessWindowInventory(pid, title);
    const window = last.matchingWindows[0];
    if (
      last.visibleCount === 1 &&
      last.matchingWindows.length === 1 &&
      window &&
      boundsEqual(window, expected) &&
      insideDisplay2(window)
    )
      return window;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Fixture did not produce the expected visible HWND on DISPLAY2 for PID " + pid);
}
async function readExactWindow(pid: number, title: string): Promise<NativeWindow> {
  const inventory = await readProcessWindowInventory(pid, title);
  const window = inventory.matchingWindows[0];
  if (inventory.visibleCount !== 1 || inventory.matchingWindows.length !== 1 || !window)
    throw new Error("Fixture no longer has exactly one visible matching HWND");
  return window;
}
async function waitForAppWindow(
  launched: Awaited<ReturnType<typeof launchZenoApp>>,
  pid: number,
): Promise<NativeWindow> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const inventory = await readProcessWindowInventory(pid).catch(() => undefined);
    const native = inventory?.visibleCount === 1 ? inventory.matchingWindows[0] : undefined;
    const expected = await launched.app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const handle = window?.getNativeWindowHandle();
      return window && handle?.length
        ? { hwnd: Number(handle.readBigUInt64LE()), bounds: window.getBounds() }
        : undefined;
    });
    if (
      native &&
      expected &&
      native.hwnd === expected.hwnd &&
      boundsEqual(expected.bounds, appBounds) &&
      insideDisplay2(native) &&
      insideDisplay2(expected.bounds)
    )
      return native;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Packaged PRSLOY PID/HWND/bounds preflight failed");
}
async function readAppWindow(pid: number): Promise<NativeWindow> {
  const inventory = await readProcessWindowInventory(pid);
  if (inventory.visibleCount !== 1 || inventory.matchingWindows.length !== 1)
    throw new Error("Packaged PRSLOY must own exactly one visible HWND");
  return inventory.matchingWindows[0]!;
}
function readProcessWindowInventory(pid: number, expectedTitle?: string): Promise<WindowInventory> {
  const titleLiteral =
    expectedTitle === undefined ? "$null" : "'" + expectedTitle.replaceAll("'", "''") + "'";
  const csharp =
    "using System;using System.Collections.Generic;using System.Runtime.InteropServices;using System.Text;" +
    "public static class PrsloyMunimStopWindows{public delegate bool EnumWindowsProc(IntPtr h,IntPtr l);" +
    "[StructLayout(LayoutKind.Sequential)]public struct RECT{public int Left;public int Top;public int Right;public int Bottom;}" +
    '[DllImport("user32.dll")]public static extern bool EnumWindows(EnumWindowsProc cb,IntPtr l);' +
    '[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);' +
    '[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);' +
    '[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out RECT r);' +
    '[DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr h);}';
  const script =
    "$ErrorActionPreference='Stop'\n" +
    "Add-Type -TypeDefinition '" +
    csharp +
    "'\n" +
    "$targetPid=[uint32]" +
    pid +
    "\n$expectedTitle=" +
    titleLiteral +
    "\n" +
    "$rows=[System.Collections.Generic.List[object]]::new()\n" +
    "$cb=[PrsloyMunimStopWindows+EnumWindowsProc]{param([IntPtr]$h,[IntPtr]$l);" +
    "[uint32]$p=0;[void][PrsloyMunimStopWindows]::GetWindowThreadProcessId($h,[ref]$p);" +
    "if($p -ne $targetPid){return $true};$r=[PrsloyMunimStopWindows+RECT]::new();" +
    "if(-not [PrsloyMunimStopWindows]::GetWindowRect($h,[ref]$r)){return $true};" +
    "$s=[System.Text.StringBuilder]::new(1024);[void][PrsloyMunimStopWindows]::GetWindowText($h,$s,$s.Capacity);" +
    "$rows.Add([pscustomobject]@{hwnd=$h.ToInt64();pid=$p;title=$s.ToString();visible=[PrsloyMunimStopWindows]::IsWindowVisible($h);" +
    "x=$r.Left;y=$r.Top;width=$r.Right-$r.Left;height=$r.Bottom-$r.Top});return $true}\n" +
    "[void][PrsloyMunimStopWindows]::EnumWindows($cb,[IntPtr]::Zero)\n" +
    "$matching=@($rows.ToArray()|Where-Object{$_.visible -and ($null -eq $expectedTitle -or $_.title -ceq $expectedTitle)})\n" +
    "$visible=@($rows.ToArray()|Where-Object{$_.visible}).Count\n" +
    "[pscustomobject]@{visibleCount=$visible;matchingWindows=@($matching)}|ConvertTo-Json -Compress -Depth 4";
  const output = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    },
  );
  return Promise.resolve(JSON.parse(output.trim()) as WindowInventory);
}
function display2StillMatches(): boolean {
  try {
    const script = String.raw`Add-Type -AssemblyName System.Windows.Forms
$s = @([System.Windows.Forms.Screen]::AllScreens | Where-Object { $_.DeviceName -eq '\\.\DISPLAY2' -and -not $_.Primary })
if ($s.Count -ne 1) { exit 1 }
$b=$s[0].Bounds; $w=$s[0].WorkingArea
if ($b.X -ne 2560 -or $b.Y -ne 0 -or $b.Width -ne 1920 -or $b.Height -ne 1080 -or $w.Bottom -ne 1032) { exit 1 }`;
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      stdio: "ignore",
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

function insideDisplay2(bounds: Bounds): boolean {
  return (
    bounds.x >= display2.left &&
    bounds.y >= display2.top &&
    bounds.x + bounds.width <= display2.right &&
    bounds.y + bounds.height <= display2.bottom
  );
}
function assertInsideDisplay2(bounds: Bounds): void {
  if (!insideDisplay2(bounds))
    throw new Error("Every test window must fit entirely inside DISPLAY2");
}
function boundsEqual(left: Bounds, right: Bounds): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}
