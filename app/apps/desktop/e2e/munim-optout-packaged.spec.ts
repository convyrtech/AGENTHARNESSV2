import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { createServer, type Server } from "node:http";
import { spawn, execFileSync } from "node:child_process";
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
type NativeWindow = Bounds & { hwnd: number; pid: number; title: string; visible?: boolean };
type WindowInventory = { visibleCount: number; matchingWindows: NativeWindow[] };
type GatewayMessage = { role?: string; content?: unknown; tool_calls?: unknown };
type PreflightDiagnostic = {
  stage: string;
  passed: boolean;
  failedChecks: string[];
  display2: {
    matched: boolean;
    screenCount: number;
    bounds?: Bounds;
    workingArea?: Bounds;
  };
  fixtureProcessAlive: boolean;
  electronMainPid?: number;
  fixture: {
    visibleCount: number;
    matchedCount: number;
    pid?: number;
    hwnd?: number;
    bounds?: Bounds;
    hwndMatches: boolean;
    boundsMatch: boolean;
    insideDisplay2: boolean;
  };
  app: {
    visibleCount: number;
    matchedCount: number;
    pid?: number;
    hwnd?: number;
    bounds?: Bounds;
    hwndMatches: boolean;
    insideDisplay2: boolean;
  };
  electronWindow?: { hwnd: number; bounds: Bounds };
  electronHwndMatches: boolean;
  electronBoundsMatch: boolean;
  electronInsideDisplay2: boolean;
};

test("packaged Munim opt-in works, then owned MCP opt-out disables it in the same isolated profile", async () => {
  test.skip(!packaged, "requires PRSLOY_E2E_PACKAGED pointing to a packaged Windows executable");
  test.skip(!munim, "requires PRSLOY_MUNIM_BINARY pointing to the verified real Munim executable");
  test.skip(process.platform !== "win32", "requires Windows UI Automation");
  test.setTimeout(180_000);
  assertInsideDisplay2(fixtureBounds);
  assertInsideDisplay2(appBounds);
  if (!display2StillMatches()) throw new Error("DISPLAY2 geometry changed before the test");

  const root = await mkdtemp(join(tmpdir(), "prsloy-munim-optout-packaged-"));
  const build = join(root, "fixture-build");
  const published = join(build, "publish");
  const obj = join(build, "obj");
  const bin = join(build, "bin");
  const fixtureOutput = join(root, "fixture-result.txt");
  const userData = join(root, "electron-userData");
  const workspace = join(root, "workspace");
  const fixtureDll = join(published, "PrsloyMunimIsolatedFixture.dll");
  let fixture: ReturnType<typeof spawn> | undefined;
  let launched: Awaited<ReturnType<typeof launchZenoApp>> | undefined;
  const ownedApps: Array<Awaited<ReturnType<typeof launchZenoApp>>> = [];
  const closedApps = new Set<Awaited<ReturnType<typeof launchZenoApp>>>();
  const stoppedModels = new Set<object>();
  let gateway: OptoutMunimGateway | undefined;
  let fixturePid = 0;
  let appPid = 0;
  let appHwnd = 0;
  let initialFixtureHwnd = 0;
  let initialDriverPids: number[] = [];
  let driverBaselineCaptured = false;
  let postOptInDriverPids: number[] = [];
  let optOutNewDriverPids: number[] = [];
  let optOutConfigDisabled = false;
  let optOutNoMunimTools = false;
  let ordinaryReplyObserved = false;
  let testFailure: unknown;
  const preflightDiagnostics: PreflightDiagnostic[] = [];

  try {
    await mkdir(published, { recursive: true });
    await mkdir(userData, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(userData, "zeno-desktop.json"),
      JSON.stringify({ recentWorkspaces: [], window: appBounds }),
    );
    await writeFile(join(workspace, "README.md"), "Synthetic isolated Munim opt-out fixture.\n");
    const agentDir = join(root, "home", ".pi", "agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          munimComputerUse: {
            command: munim,
            args: [],
            exposure: "direct",
            enabled: true,
            disabled: false,
            prsloyComputerUseOwned: true,
          },
        },
      }),
    );
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
      { stdio: "ignore", windowsHide: true },
    );
    fixturePid = fixture.pid ?? 0;
    if (!fixturePid) throw new Error("Munim fixture did not start");
    const fixtureProcess = fixture;
    const initialFixture = await waitForExactWindow(fixturePid, fixtureTitle, fixtureBounds);
    initialFixtureHwnd = initialFixture.hwnd;
    initialDriverPids = await getExactBinaryProcessIds(munim!);
    driverBaselineCaptured = true;
    gateway = await startOptoutMunimGateway({
      fixturePid,
      validateBeforeDispatch: async () => {
        const diagnostic = await inspectCurrentTarget({
          stage: "before_munim_list_apps",
          launched,
          fixtureProcess,
          fixturePid,
          fixtureHwnd: initialFixtureHwnd,
          appPid,
          appHwnd,
        });
        preflightDiagnostics.push(diagnostic);
        return diagnostic.passed;
      },
    });

    launched = await launchZenoApp({
      root,
      workspacePath: workspace,
      tools: "read,munim_list_apps",
      modelInput: ["text"],
      modelBaseUrl: gateway.baseUrl,
      modelApiKey: "local-munim-optout-fixture-only",
      env: {
        PRSLOY_COMPUTER_USE: "1",
        PRSLOY_MUNIM_BINARY: munim!,
        PRSLOY_CUA_BINARY: "",
      },
    });
    ownedApps.push(launched);
    const fixtureWindow = await readExactWindow(fixturePid, fixtureTitle);
    expect(fixtureWindow.hwnd).toBe(initialFixtureHwnd);
    expect(boundsEqual(fixtureWindow, fixtureBounds) && insideDisplay2(fixtureWindow)).toBe(true);
    appPid = await launched.app.evaluate(() => process.pid);
    if (!appPid) throw new Error("Packaged PRSLOY PID unavailable");
    const appWindow = await waitForAppWindow(launched, appPid);
    appHwnd = appWindow.hwnd;
    expect(insideDisplay2(appWindow)).toBe(true);

    await launched.fakeModel.stop();
    await launched.page.waitForSelector('[data-testid="zeno-app"][data-bootstrap-ready="true"]', {
      timeout: 120_000,
    });
    const runtime = launched.page.getByTestId("runtime-snapshot").first();
    if (!/"runtimeId":\s*"([^"]+)"/u.test((await runtime.textContent().catch(() => "")) ?? "")) {
      await assertCurrentTarget(
        launched,
        fixtureProcess,
        fixturePid,
        initialFixtureHwnd,
        appPid,
        appHwnd,
        preflightDiagnostics,
        "optin_before_start_host",
      );
      await launched.page.getByTestId("start-host").click({ force: true });
      await expect(runtime).toContainText("runtimeId", { timeout: 60_000 });
    }
    const trust = launched.page.getByTestId("project-trust-dialog-trust");
    if (await trust.isVisible()) {
      await assertCurrentTarget(
        launched,
        fixtureProcess,
        fixturePid,
        initialFixtureHwnd,
        appPid,
        appHwnd,
        preflightDiagnostics,
        "optin_before_trust",
      );
      await trust.click();
    }
    await assertCurrentTarget(
      launched,
      fixtureProcess,
      fixturePid,
      initialFixtureHwnd,
      appPid,
      appHwnd,
      preflightDiagnostics,
      "optin_before_prompt_fill",
    );
    await launched.page
      .getByTestId("prompt-input")
      .fill(
        "List the visible application windows once, then report whether the isolated fixture appears.",
      );
    await assertCurrentTarget(
      launched,
      fixtureProcess,
      fixturePid,
      initialFixtureHwnd,
      appPid,
      appHwnd,
      preflightDiagnostics,
      "optin_before_prompt_send",
    );
    await launched.page.getByTestId("send-prompt").click();
    await expect.poll(() => gateway!.toolResultVerified, { timeout: 60_000 }).toBe(true);
    await waitSettled(launched.page);
    await expect(
      launched.page.getByTestId("markdown-content").getByText("Isolated fixture listed.", {
        exact: true,
      }),
    ).toBeVisible({ timeout: 15_000 });
    const optInConfig = JSON.parse(await readFile(join(launched.agentDir, "mcp.json"), "utf8")) as {
      mcpServers?: Record<
        string,
        {
          command?: string;
          disabled?: boolean;
          enabled?: boolean;
          prsloyComputerUseOwned?: boolean;
        }
      >;
    };
    const optedInServer = optInConfig.mcpServers?.munimComputerUse;
    expect(optedInServer).toMatchObject({ command: munim, prsloyComputerUseOwned: true });
    expect(optedInServer?.disabled).toBe(true);
    expect(optedInServer?.enabled).toBe(false);
    postOptInDriverPids = await getExactBinaryProcessIds(munim!);
    expect(postOptInDriverPids.some((pid) => !initialDriverPids.includes(pid))).toBe(true);
    const optInEvidence = {
      fixturePid,
      fixtureHwnd: initialFixtureHwnd,
      appPid,
      appHwnd,
      bounds: { fixture: fixtureBounds, app: appBounds },
      toolSequence: [...gateway.toolSequence],
      fixturePresentInMunimList: gateway.fixtureListed,
      driverPidsAfterOptIn: postOptInDriverPids.length,
    };

    const firstApp = launched;
    const firstAppClosed = await Promise.race([
      firstApp.app
        .close()
        .then(() => true)
        .catch(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10_000)),
    ]);
    if (!firstAppClosed) throw new Error("First packaged app did not close within 10 seconds");
    closedApps.add(firstApp);
    const firstFakeModelStopped = await Promise.race([
      firstApp.fakeModel
        .stop()
        .then(() => true)
        .catch(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3_000)),
    ]);
    if (!firstFakeModelStopped)
      throw new Error("First local fake model did not close within 3 seconds");
    stoppedModels.add(firstApp.fakeModel);
    launched = undefined;
    await expect.poll(() => getExactBinaryProcessIds(munim!)).toEqual(initialDriverPids);
    const firstGatewayClosed = await Promise.race([
      gateway
        .close()
        .then(() => true)
        .catch(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3_000)),
    ]);
    if (!firstGatewayClosed)
      throw new Error("First loopback gateway did not close within 3 seconds");
    gateway = undefined;

    launched = await launchZenoApp({
      root,
      workspacePath: workspace,
      tools: "read,munim_list_apps",
      reply: () => "Ordinary model works with Munim opted out.",
      env: { PRSLOY_COMPUTER_USE: "0", PRSLOY_MUNIM_BINARY: "", PRSLOY_CUA_BINARY: "" },
    });
    ownedApps.push(launched);
    const secondAppPid = await launched.app.evaluate(() => process.pid);
    const secondAppWindow = await waitForAppWindow(launched, secondAppPid);
    expect(insideDisplay2(secondAppWindow)).toBe(true);
    expect(display2StillMatches()).toBe(true);
    expect(await launched.app.evaluate(() => process.pid)).toBe(secondAppPid);
    const fixtureAfterRestart = await readExactWindow(fixturePid, fixtureTitle);
    expect(fixtureAfterRestart.hwnd).toBe(initialFixtureHwnd);
    expect(
      boundsEqual(fixtureAfterRestart, fixtureBounds) && insideDisplay2(fixtureAfterRestart),
    ).toBe(true);

    await launched.page.waitForSelector('[data-testid="zeno-app"][data-bootstrap-ready="true"]', {
      timeout: 120_000,
    });
    const secondRuntime = launched.page.getByTestId("runtime-snapshot").first();
    if (
      !/"runtimeId":\s*"([^"]+)"/u.test((await secondRuntime.textContent().catch(() => "")) ?? "")
    ) {
      await assertCurrentTarget(
        launched,
        fixtureProcess,
        fixturePid,
        initialFixtureHwnd,
        secondAppPid,
        secondAppWindow.hwnd,
        preflightDiagnostics,
        "optout_before_start_host",
      );
      await launched.page.getByTestId("start-host").click({ force: true });
      await expect(secondRuntime).toContainText("runtimeId", { timeout: 60_000 });
    }
    const secondTrust = launched.page.getByTestId("project-trust-dialog-trust");
    if (await secondTrust.isVisible()) {
      await assertCurrentTarget(
        launched,
        fixtureProcess,
        fixturePid,
        initialFixtureHwnd,
        secondAppPid,
        secondAppWindow.hwnd,
        preflightDiagnostics,
        "optout_before_trust",
      );
      await secondTrust.click();
    }
    const mcpConfig = JSON.parse(await readFile(join(launched.agentDir, "mcp.json"), "utf8")) as {
      mcpServers?: Record<
        string,
        {
          command?: string;
          disabled?: boolean;
          enabled?: boolean;
          prsloyComputerUseOwned?: boolean;
        }
      >;
    };
    const ownedServer = mcpConfig.mcpServers?.munimComputerUse;
    optOutConfigDisabled =
      ownedServer?.command === munim &&
      ownedServer?.prsloyComputerUseOwned === true &&
      ownedServer?.disabled === true &&
      ownedServer?.enabled === false;
    expect(optOutConfigDisabled).toBe(true);
    await assertCurrentTarget(
      launched,
      fixtureProcess,
      fixturePid,
      initialFixtureHwnd,
      secondAppPid,
      secondAppWindow.hwnd,
      preflightDiagnostics,
      "optout_before_prompt_fill",
    );
    await launched.page.getByTestId("prompt-input").fill("Reply exactly: ordinary mode works.");
    await assertCurrentTarget(
      launched,
      fixtureProcess,
      fixturePid,
      initialFixtureHwnd,
      secondAppPid,
      secondAppWindow.hwnd,
      preflightDiagnostics,
      "optout_before_prompt_send",
    );
    await launched.page.getByTestId("send-prompt").click();
    await expect.poll(() => launched!.fakeModel.requests.length).toBeGreaterThan(0);
    await waitSettled(launched.page);
    await expect(
      launched.page
        .getByTestId("markdown-content")
        .getByText("Ordinary model works with Munim opted out.", { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    ordinaryReplyObserved = true;
    const modelRequest = launched.fakeModel.requests.at(-1) as
      | { tools?: Array<{ function?: { name?: string } }> }
      | undefined;
    const offeredTools = modelRequest?.tools?.map((tool) => tool.function?.name ?? "") ?? [];
    optOutNoMunimTools = !offeredTools.some((name) => /munim|mcp__munimComputerUse__/iu.test(name));
    expect(optOutNoMunimTools).toBe(true);
    const pidsAfterOptOut = await getExactBinaryProcessIds(munim!);
    optOutNewDriverPids = pidsAfterOptOut.filter((pid) => !initialDriverPids.includes(pid));
    expect(optOutNewDriverPids).toEqual([]);
    expect(optInEvidence.toolSequence).toEqual(["munim_list_apps"]);

    await writeFile(
      test.info().outputPath("munim-optout-packaged-evidence.json"),
      JSON.stringify(
        {
          packaged: true,
          backend: "real Munim binary for opt-in; none launched after opt-out",
          model: "local loopback scripted gateway",
          optIn: optInEvidence,
          optOut: {
            ownedMcpConfigDisabled: optOutConfigDisabled,
            ordinaryReplyObserved,
            offeredToolCount: offeredTools.length,
            munimToolsOffered: false,
            newExactBinaryProcesses: optOutNewDriverPids.length,
            fixturePid,
            fixtureHwnd: fixtureAfterRestart.hwnd,
            appPid: secondAppPid,
            appHwnd: secondAppWindow.hwnd,
          },
        },
        null,
        2,
      ),
    );
  } catch (error) {
    testFailure = error;
  } finally {
    let cleanupFailure: string | undefined;
    for (const ownedApp of ownedApps) {
      if (!closedApps.has(ownedApp)) {
        const appClosed = await Promise.race([
          ownedApp.app
            .close()
            .then(() => true)
            .catch(() => false),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10_000)),
        ]);
        if (!appClosed) cleanupFailure = "packaged app did not close within 10 seconds";
        else closedApps.add(ownedApp);
      }
      if (!stoppedModels.has(ownedApp.fakeModel)) {
        const modelStopped = await Promise.race([
          ownedApp.fakeModel
            .stop()
            .then(() => true)
            .catch(() => false),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3_000)),
        ]);
        if (!modelStopped) cleanupFailure ??= "local model fixture did not close within 3 seconds";
        else stoppedModels.add(ownedApp.fakeModel);
      }
    }
    if (gateway) {
      const gatewayClosed = await Promise.race([
        gateway
          .close()
          .then(() => true)
          .catch(() => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3_000)),
      ]);
      if (!gatewayClosed) cleanupFailure ??= "loopback gateway did not close within 3 seconds";
    }
    if (fixture) {
      const exited = new Promise<void>((resolve) => fixture!.once("exit", () => resolve()));
      if (fixture.exitCode === null && fixture.signalCode === null) fixture.kill();
      if (fixture.exitCode === null && fixture.signalCode === null)
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
      if (fixture.exitCode === null && fixture.signalCode === null)
        cleanupFailure ??= "owned fixture process did not exit within 2 seconds";
    }
    if (munim && driverBaselineCaptured) {
      const driverExited = await expect
        .poll(() => getExactBinaryProcessIds(munim), {
          timeout: 5_000,
          intervals: [250, 500, 1000],
        })
        .toEqual(initialDriverPids)
        .then(() => true)
        .catch(() => false);
      if (!driverExited)
        cleanupFailure ??= "new exact Munim executable process remained after cleanup";
    }
    try {
      await writeFile(
        test.info().outputPath("munim-optout-preflight-evidence.json"),
        JSON.stringify({ preflights: preflightDiagnostics }, null, 2),
      );
    } catch {
      cleanupFailure ??= "could not write sanitized preflight diagnostic artifact";
    }
    if (cleanupFailure) {
      testFailure ??= new Error(
        `${cleanupFailure}; preserving isolated profile and evidence at ${root}`,
      );
    } else {
      try {
        await rm(root, { recursive: true, force: true });
      } catch {
        testFailure ??= new Error(`Could not remove isolated profile; inspect ${root}`);
      }
    }
  }
  if (testFailure) throw testFailure;
});

type OptoutMunimGateway = {
  baseUrl: string;
  toolSequence: string[];
  fixtureListed: boolean;
  toolResultVerified: boolean;
  close(): Promise<void>;
};

async function startOptoutMunimGateway(options: {
  fixturePid: number;
  validateBeforeDispatch: () => Promise<boolean>;
}): Promise<OptoutMunimGateway> {
  const gateway: OptoutMunimGateway = {
    baseUrl: "",
    toolSequence: [],
    fixtureListed: false,
    toolResultVerified: false,
    close: async () => undefined,
  };
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
      let raw = "";
      for await (const chunk of req) raw += String(chunk);
      const body = JSON.parse(raw) as {
        messages?: GatewayMessage[];
        tools?: Array<{ function?: { name?: string } }>;
      };
      const tools = body.tools ?? [];
      if (!tools.some((tool) => tool.function?.name === "munim_list_apps"))
        throw new Error("The opted-in model request did not expose the Munim wrapper");
      const result = (body.messages ?? []).filter((message) => message.role === "tool").at(-1);
      if (result) {
        const text = textOf(result.content);
        gateway.fixtureListed =
          new RegExp("pid=" + options.fixturePid + "(?:\\s|$)", "u").test(text) &&
          new RegExp("pid=" + options.fixturePid + "\\s+windows=1", "u").test(text);
        if (!gateway.fixtureListed)
          throw new Error("Real Munim list_apps did not report the isolated fixture PID");
        gateway.toolResultVerified = true;
        await respond(res, undefined, gateway.toolSequence.length);
        return;
      }
      if (!(await options.validateBeforeDispatch()))
        throw new Error("PID/HWND/bounds preflight failed before Munim list_apps");
      gateway.toolSequence.push("munim_list_apps");
      await respond(res, { name: "munim_list_apps", args: {} }, 0);
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
  if (!address || typeof address === "string") throw new Error("loopback gateway bind failed");
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
  const id = "munim-optout-" + step + "-" + Date.now();
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
  if (call) {
    send({
      tool_calls: [
        {
          index: 0,
          id: id + "-call",
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        },
      ],
    });
  } else send({ content: "Isolated fixture listed." });
  send({}, call ? "tool_calls" : "stop");
  res.end("data: [DONE]\n\n");
}

async function waitForExactWindow(
  pid: number,
  title: string,
  expected: Bounds,
): Promise<NativeWindow> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const inventory = readProcessWindowInventory(pid, title);
    const window = inventory.matchingWindows[0];
    if (
      inventory.visibleCount === 1 &&
      inventory.matchingWindows.length === 1 &&
      window &&
      boundsEqual(window, expected) &&
      insideDisplay2(window)
    )
      return window;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Munim fixture did not produce its expected visible HWND on DISPLAY2");
}

async function readExactWindow(pid: number, title: string): Promise<NativeWindow> {
  const inventory = readProcessWindowInventory(pid, title);
  const window = inventory.matchingWindows[0];
  if (inventory.visibleCount !== 1 || inventory.matchingWindows.length !== 1 || !window)
    throw new Error("Fixture PID no longer owns exactly one expected visible HWND");
  return window;
}

async function waitForAppWindow(
  launched: Awaited<ReturnType<typeof launchZenoApp>>,
  pid: number,
): Promise<NativeWindow> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const inventory = readProcessWindowInventory(pid);
    const native = inventory.visibleCount === 1 ? inventory.matchingWindows[0] : undefined;
    const electron = await launched.app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const handle = window?.getNativeWindowHandle();
      return window && handle?.length
        ? { hwnd: Number(handle.readBigUInt64LE()), bounds: window.getBounds() }
        : undefined;
    });
    if (
      native &&
      electron &&
      native.hwnd === electron.hwnd &&
      boundsEqual(electron.bounds, appBounds) &&
      insideDisplay2(native) &&
      insideDisplay2(electron.bounds)
    )
      return native;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Packaged PRSLOY PID/HWND/bounds preflight failed");
}

async function assertCurrentTarget(
  launched: Awaited<ReturnType<typeof launchZenoApp>>,
  fixtureProcess: ReturnType<typeof spawn>,
  fixturePid: number,
  fixtureHwnd: number,
  appPid: number,
  appHwnd: number,
  diagnostics: PreflightDiagnostic[],
  stage: string,
): Promise<void> {
  const diagnostic = await inspectCurrentTarget({
    stage,
    launched,
    fixtureProcess,
    fixturePid,
    fixtureHwnd,
    appPid,
    appHwnd,
  });
  diagnostics.push(diagnostic);
  if (!diagnostic.passed)
    throw new Error("Current fixture/app PID-HWND-bounds preflight failed before UI action");
}

async function inspectCurrentTarget(options: {
  stage: string;
  launched: Awaited<ReturnType<typeof launchZenoApp>> | undefined;
  fixtureProcess: ReturnType<typeof spawn>;
  fixturePid: number;
  fixtureHwnd: number;
  appPid: number;
  appHwnd: number;
}): Promise<PreflightDiagnostic> {
  const display2 = inspectDisplay2();
  let electronMainPid: number | undefined;
  let electronWindow: { hwnd: number; bounds: Bounds } | undefined;
  if (options.launched) {
    try {
      electronMainPid = await options.launched.app.evaluate(() => process.pid);
    } catch {
      electronMainPid = undefined;
    }
    try {
      electronWindow = await options.launched.app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        const handle = window?.getNativeWindowHandle();
        return window && handle?.length
          ? { hwnd: Number(handle.readBigUInt64LE()), bounds: window.getBounds() }
          : undefined;
      });
    } catch {
      electronWindow = undefined;
    }
  }

  let fixtureInventory: WindowInventory | undefined;
  try {
    fixtureInventory = readProcessWindowInventory(options.fixturePid, fixtureTitle);
  } catch {
    fixtureInventory = undefined;
  }
  let appInventory: WindowInventory | undefined;
  try {
    appInventory = readProcessWindowInventory(options.appPid);
  } catch {
    appInventory = undefined;
  }
  const fixtureWindow = fixtureInventory?.matchingWindows[0];
  const appWindow = appInventory?.matchingWindows[0];
  const fixtureProcessAlive =
    options.fixtureProcess.exitCode === null && options.fixtureProcess.signalCode === null;
  const checks: Record<string, boolean> = {
    display2_matches_expected_geometry: display2.matched,
    app_reference_available: options.launched !== undefined,
    expected_pid_hwnd_available: options.appPid > 0 && options.appHwnd > 0,
    fixture_process_alive: fixtureProcessAlive,
    electron_main_pid_matches: electronMainPid === options.appPid,
    fixture_has_exactly_one_visible_window:
      fixtureInventory?.visibleCount === 1 && fixtureInventory.matchingWindows.length === 1,
    fixture_window_pid_matches: fixtureWindow?.pid === options.fixturePid,
    fixture_hwnd_matches: fixtureWindow?.hwnd === options.fixtureHwnd,
    fixture_bounds_match: fixtureWindow !== undefined && boundsEqual(fixtureWindow, fixtureBounds),
    fixture_inside_display2: fixtureWindow !== undefined && insideDisplay2(fixtureWindow),
    app_has_exactly_one_visible_window:
      appInventory?.visibleCount === 1 && appInventory.matchingWindows.length === 1,
    app_window_pid_matches: appWindow?.pid === options.appPid,
    app_hwnd_matches: appWindow?.hwnd === options.appHwnd,
    app_inside_display2: appWindow !== undefined && insideDisplay2(appWindow),
    electron_window_available: electronWindow !== undefined,
    electron_hwnd_matches: electronWindow?.hwnd === options.appHwnd,
    electron_bounds_match:
      electronWindow !== undefined && boundsEqual(electronWindow.bounds, appBounds),
    electron_inside_display2: electronWindow !== undefined && insideDisplay2(electronWindow.bounds),
  };
  const failedChecks = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  return {
    stage: options.stage,
    passed: failedChecks.length === 0,
    failedChecks,
    display2,
    fixtureProcessAlive,
    ...(electronMainPid !== undefined ? { electronMainPid } : {}),
    fixture: {
      visibleCount: fixtureInventory?.visibleCount ?? -1,
      matchedCount: fixtureInventory?.matchingWindows.length ?? -1,
      ...(fixtureWindow
        ? { pid: fixtureWindow.pid, hwnd: fixtureWindow.hwnd, bounds: pickBounds(fixtureWindow) }
        : {}),
      hwndMatches: checks.fixture_hwnd_matches ?? false,
      boundsMatch: checks.fixture_bounds_match ?? false,
      insideDisplay2: checks.fixture_inside_display2 ?? false,
    },
    app: {
      visibleCount: appInventory?.visibleCount ?? -1,
      matchedCount: appInventory?.matchingWindows.length ?? -1,
      ...(appWindow
        ? { pid: appWindow.pid, hwnd: appWindow.hwnd, bounds: pickBounds(appWindow) }
        : {}),
      hwndMatches: checks.app_hwnd_matches ?? false,
      insideDisplay2: checks.app_inside_display2 ?? false,
    },
    ...(electronWindow ? { electronWindow } : {}),
    electronHwndMatches: checks.electron_hwnd_matches ?? false,
    electronBoundsMatch: checks.electron_bounds_match ?? false,
    electronInsideDisplay2: checks.electron_inside_display2 ?? false,
  };
}

function pickBounds(bounds: Bounds): Bounds {
  return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
}

function readProcessWindowInventory(pid: number, expectedTitle?: string): WindowInventory {
  const titleLiteral =
    expectedTitle === undefined ? "$null" : "'" + expectedTitle.replaceAll("'", "''") + "'";
  const script = String.raw`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;using System.Collections.Generic;using System.Runtime.InteropServices;using System.Text;
public static class PrsloyMunimOptoutWindows{public delegate bool EnumWindowsProc(IntPtr h,IntPtr l);
[StructLayout(LayoutKind.Sequential)]public struct RECT{public int Left;public int Top;public int Right;public int Bottom;}
[DllImport("user32.dll")]public static extern bool EnumWindows(EnumWindowsProc cb,IntPtr l);
[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out RECT r);
[DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr h);}
'@
$targetPid=[uint32]${pid}; $expectedTitle=${titleLiteral}
$rows=[System.Collections.Generic.List[object]]::new()
$cb=[PrsloyMunimOptoutWindows+EnumWindowsProc]{param([IntPtr]$h,[IntPtr]$l);[uint32]$p=0;[void][PrsloyMunimOptoutWindows]::GetWindowThreadProcessId($h,[ref]$p);if($p -ne $targetPid){return $true};$r=[PrsloyMunimOptoutWindows+RECT]::new();if(-not [PrsloyMunimOptoutWindows]::GetWindowRect($h,[ref]$r)){return $true};$s=[System.Text.StringBuilder]::new(1024);[void][PrsloyMunimOptoutWindows]::GetWindowText($h,$s,$s.Capacity);$rows.Add([pscustomobject]@{hwnd=$h.ToInt64();pid=$p;title=$s.ToString();visible=[PrsloyMunimOptoutWindows]::IsWindowVisible($h);x=$r.Left;y=$r.Top;width=$r.Right-$r.Left;height=$r.Bottom-$r.Top});return $true}
[void][PrsloyMunimOptoutWindows]::EnumWindows($cb,[IntPtr]::Zero)
$matches=@($rows.ToArray()|Where-Object{$_.visible -and ($null -eq $expectedTitle -or $_.title -ceq $expectedTitle)})
$visible=@($rows.ToArray()|Where-Object{$_.visible}).Count
[pscustomobject]@{visibleCount=$visible;matchingWindows=@($matches)}|ConvertTo-Json -Compress -Depth 4
`;
  const output = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    },
  );
  return JSON.parse(output.trim()) as WindowInventory;
}

async function getExactBinaryProcessIds(binary: string): Promise<number[]> {
  const path = binary.replaceAll("'", "''");
  const script =
    "$ErrorActionPreference='Stop';$p='" +
    path +
    "';$rows=@(Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -and $_.ExecutablePath -ieq $p} | Select-Object -ExpandProperty ProcessId);ConvertTo-Json -Compress -InputObject $rows";
  const output = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    },
  );
  const parsed = JSON.parse(output.trim()) as number | number[] | null;
  return parsed === null
    ? []
    : (Array.isArray(parsed) ? parsed : [parsed]).map(Number).sort((a, b) => a - b);
}

function display2StillMatches(): boolean {
  return inspectDisplay2().matched;
}

function inspectDisplay2(): PreflightDiagnostic["display2"] {
  try {
    const script = String.raw`Add-Type -AssemblyName System.Windows.Forms
$screens = @([System.Windows.Forms.Screen]::AllScreens | Where-Object { $_.DeviceName -eq '\\.\DISPLAY2' -and -not $_.Primary })
if ($screens.Count -ne 1) {
  [pscustomobject]@{ matched=$false; screenCount=$screens.Count } | ConvertTo-Json -Compress
} else {
  $b=$screens[0].Bounds; $w=$screens[0].WorkingArea
  $bounds=[pscustomobject]@{x=$b.X;y=$b.Y;width=$b.Width;height=$b.Height}
  $working=[pscustomobject]@{x=$w.X;y=$w.Y;width=$w.Width;height=$w.Height}
  $matched=($b.X -eq 2560 -and $b.Y -eq 0 -and $b.Width -eq 1920 -and $b.Height -eq 1080 -and $w.Bottom -eq 1032)
  [pscustomobject]@{matched=$matched;screenCount=$screens.Count;bounds=$bounds;workingArea=$working}|ConvertTo-Json -Compress -Depth 3
}`;
    const output = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10_000,
      },
    );
    const result = JSON.parse(output.trim()) as PreflightDiagnostic["display2"];
    return result;
  } catch {
    return { matched: false, screenCount: -1 };
  }
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

function insideDisplay2(bounds: Bounds): boolean {
  return (
    bounds.x >= display2.left &&
    bounds.y >= display2.top &&
    bounds.x + bounds.width <= display2.right &&
    bounds.y + bounds.height <= display2.bottom
  );
}

function assertInsideDisplay2(bounds: Bounds): void {
  if (!insideDisplay2(bounds)) throw new Error("Every test window must fit inside DISPLAY2");
}

function boundsEqual(left: Bounds, right: Bounds): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}
