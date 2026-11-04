import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
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

test("packaged PRSLOY host crash persists a live Munim action and blocks retry", async () => {
  test.skip(!packaged, "requires PRSLOY_E2E_PACKAGED pointing to a packaged Windows executable");
  test.skip(!munim, "requires PRSLOY_MUNIM_BINARY pointing to the verified real Munim executable");
  test.skip(process.platform !== "win32", "requires Windows UI Automation");
  test.setTimeout(180_000);
  assertInsideDisplay2(fixtureBounds);
  assertInsideDisplay2(appBounds);
  if (!display2StillMatches()) throw new Error("DISPLAY2 geometry changed before the test");
  const root = await mkdtemp(join(tmpdir(), "prsloy-munim-crash-packaged-"));
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
  let gateway: CrashMunimGateway | undefined;
  let cleanupOk = true;
  try {
    await mkdir(published, { recursive: true });
    await mkdir(userData, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(userData, "zeno-desktop.json"),
      JSON.stringify({ recentWorkspaces: [], window: appBounds }),
    );
    await writeFile(join(workspace, "README.md"), "Synthetic isolated Munim crash fixture.\n");
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
      { stdio: "pipe", windowsHide: true, timeout: 60_000 },
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
    const validateWindows = async () => {
      if (!display2StillMatches()) return false;
      if (!launched || !appPid || !appHwnd) return false;
      if (fixtureProcess.exitCode !== null || fixtureProcess.signalCode !== null) return false;
      if ((await launched.app.evaluate(() => process.pid).catch(() => undefined)) !== appPid)
        return false;
      const currentFixture = await readExactWindow(fixturePid, fixtureTitle).catch(() => undefined);
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
    };
    gateway = await startCrashMunimGateway({ fixturePid, validateBeforeDispatch: validateWindows });
    launched = await launchZenoApp({
      root,
      workspacePath: workspace,
      tools: "read,munim_list_apps,munim_get_app_state,munim_click",
      modelInput: ["text", "image"],
      modelBaseUrl: gateway.baseUrl,
      modelApiKey: "local-munim-crash-fixture-only",
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
        {
          timeout: 30_000,
        },
      )
      .toBe(true);
    expect(await readFile(delayedEnd, "utf8").catch(() => undefined)).toBeUndefined();
    expect(await readFile(delayedResult, "utf8").catch(() => undefined)).toBeUndefined();
    const startMarkerBeforeCrash = await readFile(delayedStart, "utf8");
    const pendingBeforeCrash = await waitForPendingRecovery(launched.page);
    expect(pendingBeforeCrash[0]).toMatchObject({
      backend: "munim",
      pid: fixturePid,
      kind: "click",
    });
    expect(pendingBeforeCrash[0]!.status).toBe("dispatching");
    const actionId = pendingBeforeCrash[0]!.actionId;

    const mainIdentity = await launched.app.evaluate(({ app }) => ({
      pid: process.pid,
      userData: app.getPath("userData"),
    }));
    expect(resolve(mainIdentity.userData).toLowerCase()).toBe(resolve(userData).toLowerCase());
    const hostBeforeCrash = await readAgentHostIdentity(launched.app);
    expect(hostBeforeCrash.pid).not.toBe(mainIdentity.pid);
    gateway.hostIdentityBeforeCrash = hostBeforeCrash;
    gateway.mainProcessPid = mainIdentity.pid;
    gateway.profilePath = mainIdentity.userData;

    // Signal only the utility process verified in this Electron app's own process metrics.
    if (!(await validateWindows()))
      throw new Error("Fixture/app PID/HWND/bounds preflight failed before Agent Host crash");
    await launched.app.evaluate(
      ({ app }, target) => {
        if (process.pid !== target.mainPid || app.getPath("userData") !== target.userData)
          throw new Error("Refusing to kill a host from another Electron profile");
        const path = process.getBuiltinModule("node:path")!;
        if (
          path.resolve(app.getPath("userData")).toLowerCase() !==
          path.resolve(target.expectedUserData).toLowerCase()
        )
          throw new Error("Refusing to kill a host outside the isolated test profile");
        if (target.hostPid === process.pid)
          throw new Error("Refusing to kill Electron main/user process");
        const matches = app
          .getAppMetrics()
          .filter((metric) => metric.name === "PRSLOY Agent Host" && metric.pid === target.hostPid);
        if (matches.length !== 1 || matches[0]!.creationTime !== target.creationTime)
          throw new Error("Refusing to kill an Agent Host with changed process identity");
        const fs = process.getBuiltinModule("node:fs")!;
        if (fs.existsSync(target.delayedEnd) || fs.existsSync(target.delayedResult))
          throw new Error("Delayed effect completed before Agent Host termination");
        const sqlite = process.getBuiltinModule("node:sqlite")!;
        const db = new sqlite.DatabaseSync(
          path.join(target.expectedUserData, "prsloy", "cua-recovery.sqlite"),
          { readOnly: false },
        );
        try {
          db.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
          const row = db
            .prepare(
              "SELECT status, pid, backend FROM cua_actions WHERE action_id = ? AND profile_id = ?",
            )
            .get(target.actionId, "default") as
            | { status?: string; pid?: number; backend?: string }
            | undefined;
          if (
            row?.status !== "dispatching" ||
            row.pid !== target.fixturePid ||
            row.backend !== "munim"
          )
            throw new Error("Recovery intent is no longer dispatching for the fixture");
          if (fs.existsSync(target.delayedEnd) || fs.existsSync(target.delayedResult))
            throw new Error("Delayed effect completed before Agent Host termination");
          const current = app
            .getAppMetrics()
            .filter(
              (metric) => metric.name === "PRSLOY Agent Host" && metric.pid === target.hostPid,
            );
          if (
            current.length !== 1 ||
            current[0]!.creationTime !== target.creationTime ||
            target.hostPid === process.pid
          )
            throw new Error("Agent Host identity changed before termination");
          process.kill(target.hostPid);
          db.exec("COMMIT");
        } catch (error) {
          try {
            db.exec("ROLLBACK");
          } catch {
            /* no active transaction */
          }
          throw error;
        } finally {
          db.close();
        }
      },
      {
        mainPid: mainIdentity.pid,
        userData: mainIdentity.userData,
        expectedUserData: userData,
        hostPid: hostBeforeCrash.pid,
        creationTime: hostBeforeCrash.creationTime,
        delayedEnd,
        delayedResult,
        actionId,
        fixturePid,
      },
    );
    gateway.hostCrashSignalSent = true;

    await expect
      .poll(async () => (await listRecovery(launched!.page))[0]?.status, { timeout: 30_000 })
      .toBe("unknown");
    const pendingAfterCrash = await waitForPendingRecovery(launched.page);
    expect(pendingAfterCrash).toMatchObject([
      { actionId, status: "unknown", backend: "munim", pid: fixturePid, kind: "click" },
    ]);
    const hostAfterCrash = await waitForDifferentAgentHost(launched.app, hostBeforeCrash);
    gateway.hostIdentityAfterCrash = hostAfterCrash;
    expect(hostAfterCrash.pid).not.toBe(mainIdentity.pid);
    expect(
      hostAfterCrash.pid !== hostBeforeCrash.pid ||
        hostAfterCrash.creationTime !== hostBeforeCrash.creationTime,
    ).toBe(true);
    expect(await launched.app.evaluate(({ app }) => app.getPath("userData"))).toBe(
      mainIdentity.userData,
    );
    await expect(launched.page.getByTestId("host-status").first()).toContainText(
      /Agent Host ready|Agent Host restarted|Agent settled|就绪/u,
      { timeout: 60_000 },
    );

    await sendPrompt(
      launched.page,
      "Crash gate probe: inspect and try the same delayed action once.",
    );
    await expect
      .poll(() => gateway!.repeatAttemptBlocked, { timeout: 60_000 })
      .toBe(true)
      .catch(() => {
        throw new Error(
          `Crash retry probe did not complete: ${JSON.stringify({ requests: gateway!.modelRequestCount, progress: gateway!.progress })}`,
        );
      });
    await waitSettled(launched.page);
    const pendingAfterRepeat = await listRecovery(launched.page);
    expect(pendingAfterRepeat).toMatchObject([
      { actionId, status: "unknown", backend: "munim", pid: fixturePid, kind: "click" },
    ]);
    expect(gateway.repeatBlockObservedBeforeRawDispatch).toBe(true);
    expect(gateway.scriptedWrapperClickCalls).toBe(2);

    // The action can finish after host loss, or the backend can stop. Record the bounded observation.
    const lateEffectCompleted = await expect
      .poll(
        () =>
          readFile(delayedEnd, "utf8")
            .then((value) => value.trim().length > 0)
            .catch(() => false),
        { timeout: 35_000, intervals: [200, 500, 1000] },
      )
      .toBe(true)
      .then(() => true)
      .catch(() => false);
    const delayedResultValue = await readFile(delayedResult, "utf8").catch(() => undefined);
    expect(await readFile(delayedStart, "utf8")).toBe(startMarkerBeforeCrash);
    if (lateEffectCompleted) expect(delayedResultValue).toBe("completed");

    await acknowledgeRecovery(launched.page, "cua-recovery-accept-unknown");
    expect(await listRecovery(launched.page)).toHaveLength(0);
    expect(gateway.scriptedWrapperClickCalls).toBe(2);
    expect(await readFile(delayedStart, "utf8")).toBe(startMarkerBeforeCrash);
    const fixtureStartMarkerCount = (await readFile(delayedStart, "utf8"))
      .trim()
      .split(/\r?\n/u).length;
    const fixtureEndMarkerCount = await readFile(delayedEnd, "utf8")
      .then((value) => value.trim().split(/\r?\n/u).length)
      .catch(() => 0);
    expect(fixtureStartMarkerCount).toBe(1);
    if (lateEffectCompleted) expect(fixtureEndMarkerCount).toBe(1);
    expect(gateway.topLevelRawToolsAbsent).toBe(true);

    const finalFixture = await readExactWindow(fixturePid, fixtureTitle);
    const finalApp = await readAppWindow(mainIdentity.pid);
    expect(finalFixture.hwnd).toBe(initialFixtureWindow.hwnd);
    expect(boundsEqual(finalFixture, fixtureBounds) && insideDisplay2(finalFixture)).toBe(true);
    expect(finalApp.hwnd).toBe(appWindow.hwnd);
    expect(insideDisplay2(finalApp)).toBe(true);
    await writeFile(
      test.info().outputPath("munim-crash-packaged-evidence.json"),
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
        appPid: mainIdentity.pid,
        appHwnd: finalApp.hwnd,
        appBounds: { x: finalApp.x, y: finalApp.y, width: finalApp.width, height: finalApp.height },
        isolatedProfile: "same temporary Electron userData directory before and after host crash",
        hostIdentityBeforeCrash: hostBeforeCrash,
        hostIdentityAfterCrash: hostAfterCrash,
        hostCrashSignalSent: gateway.hostCrashSignalSent,
        durableActionId: actionId,
        durableStatusAfterCrash: pendingAfterCrash[0]?.status,
        freshTurnRepeatBlockedBeforeNestedDispatch: gateway.repeatBlockObservedBeforeRawDispatch,
        scriptedWrapperClickCalls: gateway.scriptedWrapperClickCalls,
        rawMunimActionCallCount: "not instrumented; this test does not claim a backend call count",
        fixtureStartMarkerCount,
        fixtureEndMarkerCount,
        delayedResult: lateEffectCompleted ? delayedResultValue : "not completed within 35 seconds",
        lateEffectCompletedWithin35Seconds: lateEffectCompleted,
        ownerResolution: "accept_unknown; no retry followed",
      }),
    );
  } finally {
    let appClosed = true;
    if (launched) {
      appClosed = await boundedCleanup(() => launched!.app.close());
      await boundedCleanup(() => launched!.fakeModel.stop());
    }
    if (gateway) await boundedCleanup(() => gateway!.close());
    if (fixture) {
      const exited = once(fixture, "exit").catch(() => undefined);
      if (fixture.exitCode === null && fixture.signalCode === null) fixture.kill();
      if (fixture.exitCode === null && fixture.signalCode === null)
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    }
    if (appClosed && (!fixture || fixture.exitCode !== null || fixture.signalCode !== null)) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    } else {
      cleanupOk = false;
      test.info().annotations.push({
        type: "cleanup",
        description: "Test process did not close; retained its isolated profile.",
      });
    }
  }
  expect(cleanupOk, "Test process did not close; isolated profile retained").toBe(true);
});

type CrashMunimGateway = {
  baseUrl: string;
  modelRequestCount: number;
  scriptedWrapperClickCalls: number;
  delayedClickIssued: boolean;
  repeatAttemptBlocked: boolean;
  repeatBlockObservedBeforeRawDispatch: boolean;
  topLevelRawToolsAbsent: boolean;
  hostCrashSignalSent: boolean;
  progress: string[];
  mainProcessPid?: number;
  profilePath?: string;
  hostIdentityBeforeCrash?: AgentHostIdentity;
  hostIdentityAfterCrash?: AgentHostIdentity;
  close(): Promise<void>;
};
type AgentHostIdentity = { pid: number; creationTime: number; name: "PRSLOY Agent Host" };

async function startCrashMunimGateway(options: {
  fixturePid: number;
  validateBeforeDispatch: () => Promise<boolean>;
}): Promise<CrashMunimGateway> {
  const gateway: CrashMunimGateway = {
    baseUrl: "",
    modelRequestCount: 0,
    scriptedWrapperClickCalls: 0,
    delayedClickIssued: false,
    repeatAttemptBlocked: false,
    repeatBlockObservedBeforeRawDispatch: false,
    topLevelRawToolsAbsent: true,
    hostCrashSignalSent: false,
    progress: [],
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
      gateway.progress.push(
        ["munim_list_apps", "munim_get_app_state", "munim_click"].includes(toolName)
          ? toolName
          : "other",
      );
      const latestUser =
        messages
          .filter((message) => message.role === "user")
          .map((message) => textOf(message.content))
          .at(-1) ?? "";
      gateway.topLevelRawToolsAbsent =
        gateway.topLevelRawToolsAbsent &&
        !tools.some((tool) => (tool.function?.name ?? "").startsWith("mcp__munimComputerUse__"));
      if (latestUser.includes("Crash gate probe:") && phase !== "repeat") {
        phase = "repeat";
        await respond(res, wrapper("munim_list_apps", {}), results.length);
        return;
      }
      if (!toolName && phase === "initial") {
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
        gateway.scriptedWrapperClickCalls += 1;
        if (phase === "initial") gateway.delayedClickIssued = true;
        await respond(
          res,
          wrapper("munim_click", { pid: options.fixturePid, element_token: token }),
          results.length,
        );
        return;
      }
      if (toolName === "munim_click" && phase === "repeat") {
        gateway.repeatAttemptBlocked = /CUA_RECOVERY_BLOCKED/u.test(resultText);
        gateway.repeatBlockObservedBeforeRawDispatch =
          gateway.repeatAttemptBlocked &&
          /Munim не вызван|Munim was not called|не вызван/iu.test(resultText);
        if (!gateway.repeatAttemptBlocked)
          throw new Error("Durable recovery gate did not reject repeat action: " + resultText);
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
  const id = "munim-crash-" + step + "-" + Date.now();
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
  const rows = text
    .split(/\r?\n/u)
    .filter((line) => new RegExp(`\\bpid=${pid}(?:[ \\t]|$)`, "u").test(line));
  if (rows.length !== 1 || !/(?:^|[ \t])windows=1(?:[ \t]|$)/u.test(rows[0]!))
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
async function acknowledgeRecovery(
  page: import("playwright").Page,
  resolution: "cua-recovery-accept-unknown",
): Promise<void> {
  const open = page.getByRole("button", {
    name: /Проверить действие (?:Cua|Munim)|Review (?:Cua|Munim) action/u,
  });
  await expect(open).toBeVisible({ timeout: 45_000 });
  await open.click();
  const dialog = page.getByTestId("cua-recovery-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("cua-recovery-acknowledge")).toBeEnabled({ timeout: 15_000 });
  await page.getByTestId("cua-recovery-acknowledge").check();
  await page.getByTestId(resolution).click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
}
async function listRecovery(page: import("playwright").Page): Promise<RecoveryItem[]> {
  return page.evaluate(() => window.zeno.prsloy.cuaRecovery.list()) as Promise<RecoveryItem[]>;
}
async function waitForPendingRecovery(page: import("playwright").Page): Promise<RecoveryItem[]> {
  await expect.poll(async () => (await listRecovery(page)).length, { timeout: 15_000 }).toBe(1);
  return listRecovery(page);
}

async function readAgentHostIdentity(
  app: Awaited<ReturnType<typeof launchZenoApp>>["app"],
): Promise<AgentHostIdentity> {
  const hosts = await app.evaluate(({ app }) =>
    app
      .getAppMetrics()
      .filter((metric) => metric.name === "PRSLOY Agent Host")
      .map(({ pid, creationTime, name }) => ({ pid, creationTime, name })),
  );
  if (hosts.length !== 1 || !hosts[0]?.pid || !Number.isFinite(hosts[0].creationTime))
    throw new Error("Expected exactly one measurable PRSLOY Agent Host process");
  return hosts[0] as AgentHostIdentity;
}

async function waitForDifferentAgentHost(
  app: Awaited<ReturnType<typeof launchZenoApp>>["app"],
  previous: AgentHostIdentity,
): Promise<AgentHostIdentity> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const current = await readAgentHostIdentity(app);
      if (current.pid !== previous.pid || current.creationTime !== previous.creationTime)
        return current;
    } catch {
      // The host supervisor may be between the crashed and replacement process.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("A replacement Agent Host did not appear within 30 seconds");
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
    "public static class PrsloyMunimCrashWindows{public delegate bool EnumWindowsProc(IntPtr h,IntPtr l);" +
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
    "$cb=[PrsloyMunimCrashWindows+EnumWindowsProc]{param([IntPtr]$h,[IntPtr]$l);" +
    "[uint32]$p=0;[void][PrsloyMunimCrashWindows]::GetWindowThreadProcessId($h,[ref]$p);" +
    "if($p -ne $targetPid){return $true};$r=[PrsloyMunimCrashWindows+RECT]::new();" +
    "if(-not [PrsloyMunimCrashWindows]::GetWindowRect($h,[ref]$r)){return $true};" +
    "$s=[System.Text.StringBuilder]::new(1024);[void][PrsloyMunimCrashWindows]::GetWindowText($h,$s,$s.Capacity);" +
    "$rows.Add([pscustomobject]@{hwnd=$h.ToInt64();pid=$p;title=$s.ToString();visible=[PrsloyMunimCrashWindows]::IsWindowVisible($h);" +
    "x=$r.Left;y=$r.Top;width=$r.Right-$r.Left;height=$r.Bottom-$r.Top});return $true}\n" +
    "[void][PrsloyMunimCrashWindows]::EnumWindows($cb,[IntPtr]::Zero)\n" +
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
async function boundedCleanup(
  operation: () => Promise<unknown>,
  timeoutMs = 5_000,
): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    void Promise.resolve()
      .then(operation)
      .then(
        () => {
          clearTimeout(timer);
          resolve(true);
        },
        () => {
          clearTimeout(timer);
          resolve(false);
        },
      );
  });
}
function boundsEqual(left: Bounds, right: Bounds): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}
