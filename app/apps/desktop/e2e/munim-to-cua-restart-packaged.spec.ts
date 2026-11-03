import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { createServer, type Server } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { allowedCuaConfig } from "../src/agent-host/computer-use-mcp.ts";
import { expect, launchZenoApp, test, waitSettled } from "./fixtures.ts";

const packaged = process.env.PRSLOY_E2E_PACKAGED?.trim();
const munim = process.env.PRSLOY_MUNIM_BINARY?.trim();
const cua = process.env.PRSLOY_CUA_BINARY?.trim();
const expectedMunim = String.raw`C:\Users\paxalb\AppData\Local\Temp\opencode\munim-104\munim-computer-use.exe`;
const expectedCua = String.raw`C:\Users\paxalb\AppData\Local\Temp\cua-104-portable\extracted\cua-driver.exe`;
const fixtureProject = fileURLToPath(
  new URL("./munim-backend-failure-fixture/MunimBackendFailureFixture.csproj", import.meta.url),
);
const proxyProject = fileURLToPath(
  new URL("./munim-backend-failure-proxy/MunimBackendFailureProxy.csproj", import.meta.url),
);
const fixtureTitle = "PRSLOY Backend Failure Fixture";
const display2 = { left: 2560, top: 0, right: 4480, bottom: 1032 };
const fixtureBounds = { x: 2640, y: 80, width: 600, height: 300 };
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
type SafeRecoveryItem = Pick<RecoveryItem, "actionId" | "backend" | "pid" | "kind" | "status">;
function sanitizeRecoveryItems(items: RecoveryItem[] | undefined): SafeRecoveryItem[] | undefined {
  return items?.map(({ actionId, backend, pid, kind, status }) => ({
    actionId,
    backend,
    pid,
    kind,
    status,
  }));
}

test("recovery evidence allowlist drops challenge capabilities", () => {
  const row = {
    actionId: "synthetic-action",
    backend: "munim",
    pid: 42,
    kind: "click",
    status: "unknown",
    challenge: "synthetic-capability",
  };
  const serialized = JSON.stringify(sanitizeRecoveryItems([row]));
  expect(serialized).toContain("synthetic-action");
  expect(serialized).not.toContain("challenge");
  expect(serialized).not.toContain("synthetic-capability");
});

test("owned native app window baseline requires the same PID, HWND, bounds, and DISPLAY2", () => {
  const baseline: NativeWindow = {
    pid: 123,
    hwnd: 456,
    title: "PRSLOY",
    ...appBounds,
  };
  expect(matchesOwnedNativeWindow(baseline, baseline, 123)).toBe(true);
  expect(matchesOwnedNativeWindow({ ...baseline, pid: 124 }, baseline, 123)).toBe(false);
  expect(matchesOwnedNativeWindow({ ...baseline, hwnd: 457 }, baseline, 123)).toBe(false);
  expect(matchesOwnedNativeWindow({ ...baseline, x: baseline.x + 1 }, baseline, 123)).toBe(false);
  expect(matchesOwnedNativeWindow({ ...baseline, x: display2.left - 1 }, baseline, 123)).toBe(
    false,
  );
});

test("owned process inventory handles empty and current-image results", () => {
  test.skip(process.platform !== "win32", "requires Windows process identity APIs");
  const absentImage = join(tmpdir(), `prsloy-no-such-process-${process.pid}.exe`);
  expect(queryExactProcessIdentities(absentImage)).toEqual([]);
  const currentImage = queryExactProcessIdentities(process.execPath);
  expect(currentImage.some((identity) => identity.pid === process.pid)).toBe(true);
  expect(() => queryProcessIdentity(0)).toThrow("invalid owned process PID");
  expect(queryProcessIdentity(2_147_483_647)).toBeUndefined();
  let queryError: unknown;
  try {
    queryExactProcessIdentities(join(tmpdir(), "prsloy-invalid-wildcard-[.exe"));
  } catch (error) {
    queryError = error;
  }
  expect(queryError).toBeDefined();
  expect(String((queryError as NodeJS.ErrnoException & { stderr?: Buffer }).stderr)).toContain(
    "owned_process_query_failed",
  );
});

test("isolated renamed Cua copy preserves bytes and is accepted by the backend config", async () => {
  test.skip(!cua, "requires the verified portable real Cua executable");
  test.skip(process.platform !== "win32", "requires the Windows portable Cua build");
  if (resolve(cua!).toLowerCase() !== resolve(expectedCua).toLowerCase())
    throw new Error("This check requires the designated portable Cua binary");
  const root = await mkdtemp(join(tmpdir(), "prsloy-cua-copy-offline-"));
  let cleanupOk = true;
  try {
    const copied = await copyPortableCuaWithUniqueName(cua!, join(root, "portable"));
    const sourceVersion = execFileSync(cua!, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      timeout: 10_000,
    });
    const copiedVersion = execFileSync(copied.path, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      timeout: 10_000,
    });
    expect(copiedVersion.trim()).toBe(sourceVersion.trim());
    const accepted = allowedCuaConfig({ command: copied.path }, copied.path);
    expect(accepted).toMatchObject({ command: copied.path, args: ["mcp", "--direct"] });
  } finally {
    const resolvedRoot = resolve(root);
    const tempParent = resolve(tmpdir());
    if (
      dirname(resolvedRoot).toLowerCase() !== tempParent.toLowerCase() ||
      !basename(resolvedRoot).startsWith("prsloy-cua-copy-offline-")
    ) {
      cleanupOk = false;
    } else {
      await rm(resolvedRoot, { recursive: true, force: true }).catch(() => {
        cleanupOk = false;
      });
    }
  }
  expect(cleanupOk, "Cua copy test could not safely remove its isolated temporary directory").toBe(
    true,
  );
});

test("packaged PRSLOY preserves Munim unknown action across full app restart and blocks fresh Cua action", async () => {
  test.skip(!packaged, "requires PRSLOY_E2E_PACKAGED pointing to a packaged Windows executable");
  test.skip(!munim, "requires PRSLOY_MUNIM_BINARY pointing to the verified real Munim executable");
  test.skip(
    !cua,
    "requires PRSLOY_CUA_BINARY pointing to the verified portable real Cua executable",
  );
  test.skip(process.platform !== "win32", "requires Windows UI Automation");
  test.setTimeout(300_000);
  if (resolve(munim!).toLowerCase() !== resolve(expectedMunim).toLowerCase())
    throw new Error("This test requires the designated real Munim binary");
  if (resolve(cua!).toLowerCase() !== resolve(expectedCua).toLowerCase())
    throw new Error("This test requires the designated real Cua binary");
  await readFile(munim!);
  await readFile(cua!);
  assertInsideDisplay2(fixtureBounds);
  assertInsideDisplay2(appBounds);
  if (!display2StillMatches()) throw new Error("DISPLAY2 geometry changed before the test");
  const root = await mkdtemp(join(tmpdir(), "prsloy-munim-to-cua-restart-"));
  const build = join(root, "fixture-build");
  const published = join(build, "publish");
  const proxyBuild = join(root, "proxy-build");
  const obj = join(build, "obj");
  const bin = join(build, "bin");
  const proxyObj = join(proxyBuild, "obj");
  const proxyBin = join(proxyBuild, "bin");
  const identityPath = join(root, "fixture-identity.json");
  const delayedStart = join(root, "fixture-action-started.txt");
  const delayedEnd = join(root, "fixture-action-ended.txt");
  const killPermit = join(root, "allow-owned-munim-child-termination.json");
  const proxyLog = join(root, "sanitized-munim-proxy.jsonl");
  const proxyDir = join(root, "test-proxy");
  const proxyExe = join(proxyDir, "munim-computer-use.exe");
  const proxyConfig = join(proxyDir, "munim-backend-failure.json");
  const userData = join(root, "electron-userData");
  const workspace = join(root, "workspace");
  const fixtureDll = join(published, "PrsloyMunimBackendFailureFixture.dll");
  let isolatedCua: IsolatedCuaBinary | undefined;
  let fixture: ReturnType<typeof spawn> | undefined;
  let launched: Awaited<ReturnType<typeof launchZenoApp>> | undefined;
  let gateway: CrashMunimGateway | undefined;
  let cuaGateway: RestartCuaGateway | undefined;
  let firstLaunch: Awaited<ReturnType<typeof launchZenoApp>> | undefined;
  let munimBaseline: OwnedProcessIdentity[] = [];
  let proxyBaseline: OwnedProcessIdentity[] = [];
  let cuaBaseline: OwnedProcessIdentity[] = [];
  let launchedCuaDrivers: OwnedProcessIdentity[] = [];
  const appAndHostIdentities: OwnedProcessIdentity[] = [];
  let pendingAfterFullClose: RecoveryItem[] | undefined;
  let actionIdEvidence: string | undefined;
  let durableBeforeCloseEvidence: RecoveryItem[] | undefined;
  let stage = "setup";
  let cleanupOk = true;
  let preserveFailureRoot = false;
  try {
    await mkdir(published, { recursive: true });
    await mkdir(proxyDir, { recursive: true });
    await mkdir(userData, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(userData, "zeno-desktop.json"),
      JSON.stringify({ recentWorkspaces: [], window: appBounds }),
    );
    await writeFile(
      join(workspace, "README.md"),
      "Synthetic isolated cross-backend failure fixture.\n",
    );
    publish(fixtureProject, published, bin, obj);
    publish(proxyProject, proxyDir, proxyBin, proxyObj);
    await readFile(fixtureDll);
    await readFile(proxyExe);
    const sanitizerOutput = execFileSync(proxyExe, ["--sanitizer-self-test"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      timeout: 10_000,
    });
    if (!sanitizerOutput.includes("passed"))
      throw new Error("Munim fixture sanitizer offline contract did not pass");
    isolatedCua = await copyPortableCuaWithUniqueName(cua!, join(root, "portable-cua"));
    expect(allowedCuaConfig({ command: isolatedCua.path }, isolatedCua.path)).toMatchObject({
      command: isolatedCua.path,
      args: ["mcp", "--direct"],
    });
    stage = "drivers-ready";

    fixture = spawn(
      "dotnet",
      [fixtureDll, identityPath, delayedStart, delayedEnd, String(fixtureBounds.x)],
      {
        stdio: "ignore",
        windowsHide: true,
      },
    );
    const fixturePid = fixture.pid;
    if (!fixturePid) throw new Error("Munim delayed fixture did not start");
    const fixtureProcess = fixture;
    const initialFixtureWindow = await waitForExactWindow(fixturePid, fixtureTitle, fixtureBounds);
    stage = "fixture-ready";
    await writeFile(
      proxyConfig,
      JSON.stringify({
        target: munim,
        log: proxyLog,
        startSentinel: delayedStart,
        endSentinel: delayedEnd,
        killPermit,
        fixturePid,
        fixtureHwnd: initialFixtureWindow.hwnd,
        fixtureTitle,
        fixtureX: fixtureBounds.x,
        fixtureY: fixtureBounds.y,
        fixtureWidth: fixtureBounds.width,
        fixtureHeight: fixtureBounds.height,
      }),
    );
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
    munimBaseline = queryExactProcessIdentities(munim!);
    proxyBaseline = queryExactProcessIdentities(proxyExe);
    cuaBaseline = queryExactProcessIdentities(isolatedCua.path);
    launched = await launchZenoApp({
      root,
      workspacePath: workspace,
      tools: "read,munim_list_apps,munim_get_app_state,munim_click",
      modelInput: ["text", "image"],
      modelBaseUrl: gateway.baseUrl,
      modelApiKey: "local-munim-crash-fixture-only",
      env: { PRSLOY_COMPUTER_USE: "1", PRSLOY_MUNIM_BINARY: proxyExe, PRSLOY_CUA_BINARY: "" },
    });
    stage = "app1-launched";
    const launchedMainIdentity = queryProcessIdentity(
      await launched.app.evaluate(() => process.pid),
    );
    if (!launchedMainIdentity) throw new Error("Could not identify first packaged app process");
    appAndHostIdentities.push(launchedMainIdentity);
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
    expect(mcp.mcpServers?.munimComputerUse?.command).toBe(proxyExe);
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

    await sendPrompt(launched.page, "Start the isolated fixture action once.");
    stage = "munim-prompt-sent";
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
    stage = "fixture-action-started";
    expect(await readFile(delayedEnd, "utf8").catch(() => undefined)).toBeUndefined();
    await waitForProxyEvent(proxyLog, "fixture-action-started", 15_000);
    const pendingBeforeCrash = await waitForPendingRecovery(launched.page);
    expect(pendingBeforeCrash[0]).toMatchObject({
      backend: "munim",
      pid: fixturePid,
      kind: "click",
    });
    expect(pendingBeforeCrash[0]!.status).toBe("dispatching");
    const actionId = pendingBeforeCrash[0]!.actionId;
    actionIdEvidence = actionId;
    if (!display2StillMatches())
      throw new Error("DISPLAY2 geometry changed before controlled Munim child termination");
    const fixtureBeforeKill = await readExactWindow(fixturePid, fixtureTitle);
    expect(fixtureBeforeKill.hwnd).toBe(initialFixtureWindow.hwnd);
    expect(boundsEqual(fixtureBeforeKill, fixtureBounds) && insideDisplay2(fixtureBeforeKill)).toBe(
      true,
    );
    await writeFile(
      killPermit,
      JSON.stringify({ actionId, fixturePid, fixtureHwnd: fixtureBeforeKill.hwnd }),
    );
    stage = "munim-child-termination-permitted";
    await waitForProxyEvent(proxyLog, "real-munim-child-exited-after-controlled-kill", 10_000);
    expect(await readFile(delayedEnd, "utf8").catch(() => undefined)).toBeUndefined();
    await expect
      .poll(async () => (await listRecovery(launched!.page))[0]?.status, { timeout: 15_000 })
      .toBe("unknown");
    expect(await listRecovery(launched.page)).toMatchObject([
      { actionId, backend: "munim", status: "unknown", pid: fixturePid, kind: "click" },
    ]);
    durableBeforeCloseEvidence = await listRecovery(launched.page);
    stage = "action-unknown-before-close";

    const mainIdentity = await launched.app.evaluate(({ app }) => ({
      pid: process.pid,
      userData: app.getPath("userData"),
    }));
    expect(resolve(mainIdentity.userData).toLowerCase()).toBe(resolve(userData).toLowerCase());
    const hostBeforeCrash = await readAgentHostIdentity(launched.app);
    expect(hostBeforeCrash.pid).not.toBe(mainIdentity.pid);
    const firstMainProcess = queryProcessIdentity(mainIdentity.pid);
    const firstHostProcess = queryProcessIdentity(hostBeforeCrash.pid);
    expect(firstMainProcess?.path.toLowerCase()).toBe(packaged!.toLowerCase());
    if (!firstMainProcess || !firstHostProcess)
      throw new Error("Could not identify app and Agent Host processes");
    appAndHostIdentities.push(firstHostProcess);
    gateway.hostIdentityBeforeCrash = hostBeforeCrash;
    gateway.mainProcessPid = mainIdentity.pid;
    gateway.profilePath = mainIdentity.userData;

    // Full close app 1; its Host is now fully gone while the fixture effect remains active.
    const firstApp = launched;
    firstLaunch = firstApp;
    const firstMainPid = mainIdentity.pid;
    await firstApp.app.close();
    launched = undefined;
    await firstApp.fakeModel.stop();
    stage = "app1-closed";
    expect(await waitForProcessIdentityGone(firstMainProcess, 10_000)).toBe(true);
    expect(await waitForProcessIdentityGone(firstHostProcess, 10_000)).toBe(true);
    expect(await readFile(delayedEnd, "utf8").catch(() => undefined)).toBeUndefined();
    const proxyEventsAfterKill = await readProxyEvents(proxyLog);
    assertSafeProxyLog(proxyEventsAfterKill);
    assertOwnedMunimLifecycle(proxyEventsAfterKill, munim!, proxyExe);
    expect(await waitForNoNewProcesses(proxyExe, proxyBaseline, 10_000)).toBe(true);
    // Let the single UI effect finish before app 2 tests recovery, so no delayed click can occur later.
    await expect
      .poll(() => readFile(delayedEnd, "utf8").catch(() => ""), { timeout: 65_000 })
      .not.toBe("");
    stage = "fixture-action-completed";
    expect((await readFile(delayedStart, "utf8")).trim().split(/\r?\n/u)).toHaveLength(1);
    expect((await readFile(delayedEnd, "utf8")).trim().split(/\r?\n/u)).toHaveLength(1);
    expect(await waitForNoNewProcesses(munim!, munimBaseline, 10_000)).toBe(true);

    // Relaunch from the same root/profile with the real Cua driver.
    cuaGateway = await startRestartCuaGateway({ fixturePid, fixtureTitle });
    launched = await launchZenoApp({
      root,
      workspacePath: workspace,
      tools: "read,cua_list_windows,cua_get_window_state,cua_click",
      modelInput: ["text", "image"],
      modelBaseUrl: cuaGateway.baseUrl,
      modelApiKey: "local-cross-backend-recovery-test-only",
      env: {
        PRSLOY_COMPUTER_USE: "1",
        PRSLOY_CUA_BINARY: isolatedCua.path,
        PRSLOY_MUNIM_BINARY: "",
      },
    });
    stage = "app2-launched";
    const launchedSecondMainIdentity = queryProcessIdentity(
      await launched.app.evaluate(() => process.pid),
    );
    if (!launchedSecondMainIdentity)
      throw new Error("Could not identify second packaged app process");
    appAndHostIdentities.push(launchedSecondMainIdentity);
    await launched.fakeModel.stop();
    expect(await launched.app.evaluate(({ app }) => app.getPath("userData"))).toBe(userData);
    const app2Identity = await launched.app.evaluate(({ app }) => ({
      pid: process.pid,
      userData: app.getPath("userData"),
    }));
    const app2Window = await waitForAppWindow(launched, app2Identity.pid);
    cuaGateway.appPid = app2Identity.pid;
    cuaGateway.appHwnd = app2Window.hwnd;
    cuaGateway.appNativeBaseline = app2Window;
    if (launchedSecondMainIdentity.path.toLowerCase() !== packaged!.toLowerCase())
      throw new Error("Second app process is not the expected packaged PRSLOY binary");
    expect(resolve(app2Identity.userData).toLowerCase()).toBe(resolve(userData).toLowerCase());
    expect(insideDisplay2(app2Window)).toBe(true);
    await launched.page.waitForSelector('[data-testid="zeno-app"][data-bootstrap-ready="true"]', {
      timeout: 120_000,
    });
    pendingAfterFullClose = await waitForPendingRecovery(launched.page);
    expect(pendingAfterFullClose).toMatchObject([
      { actionId, backend: "munim", status: "unknown", pid: fixturePid, kind: "click" },
    ]);
    stage = "action-unknown-after-profile-restart";
    const runtime2 = launched.page.getByTestId("runtime-snapshot").first();
    if (!/"runtimeId":\s*"([^"]+)"/u.test((await runtime2.textContent().catch(() => "")) ?? "")) {
      await launched.page.getByTestId("start-host").click({ force: true });
      await expect(runtime2).toContainText("runtimeId", { timeout: 60_000 });
    }
    const secondHost = await readAgentHostIdentity(launched.app);
    const secondHostProcess = queryProcessIdentity(secondHost.pid);
    const secondMainProcess = queryProcessIdentity(app2Identity.pid);
    if (!secondHostProcess || !secondMainProcess)
      throw new Error("Could not identify second app and Agent Host processes");
    if (
      !appAndHostIdentities.some(
        (identity) =>
          identity.pid === secondMainProcess.pid &&
          identity.creationUtcTicks === secondMainProcess.creationUtcTicks,
      )
    )
      appAndHostIdentities.push(secondMainProcess);
    appAndHostIdentities.push(secondHostProcess);
    // Cua is injected into the Agent Host from PRSLOY_CUA_BINARY; mcp.json is not its config source.
    const trust2 = launched.page.getByTestId("project-trust-dialog-trust");
    if (await trust2.isVisible().catch(() => false)) await trust2.click();
    expect(await listRecovery(launched.page)).toMatchObject(pendingAfterFullClose);

    await sendPrompt(
      launched.page,
      "Cross-backend fresh Cua token probe: inspect the fixture, then click its delayed action once.",
    );
    await expect.poll(() => cuaGateway!.freshSnapshotObtained, { timeout: 60_000 }).toBe(true);
    stage = "cua-fresh-snapshot";
    const baselineKeys = new Set(
      cuaBaseline.map((row) => `${row.pid}:${row.creationUtcTicks}:${row.path.toLowerCase()}`),
    );
    launchedCuaDrivers = queryExactProcessIdentities(isolatedCua.path).filter(
      (row) => !baselineKeys.has(`${row.pid}:${row.creationUtcTicks}:${row.path.toLowerCase()}`),
    );
    if (launchedCuaDrivers.length === 0)
      throw new Error("Real Cua driver did not launch for the fresh snapshot probe");
    appAndHostIdentities.push(...launchedCuaDrivers);
    await expect.poll(() => cuaGateway!.clickRejectedByRecovery, { timeout: 60_000 }).toBe(true);
    stage = "cua-recovery-gate-rejected-action";
    await waitSettled(launched.page);
    expect(cuaGateway.wrapperReportedClickDispatched).toBe(false);
    expect(cuaGateway.fixtureListed).toBe(true);
    expect(await listRecovery(launched.page)).toMatchObject([
      { actionId, backend: "munim", status: "unknown", pid: fixturePid, kind: "click" },
    ]);
    expect(await readFile(delayedEnd, "utf8").catch(() => "")).not.toBe("");
    expect(cuaGateway.externalRequestCount).toBe(0);
    expect(cuaGateway.errors).toEqual([]);
    const finalFixture = await readExactWindow(fixturePid, fixtureTitle);
    expect(finalFixture.hwnd).toBe(initialFixtureWindow.hwnd);
    expect(boundsEqual(finalFixture, fixtureBounds) && insideDisplay2(finalFixture)).toBe(true);
    const finalApp2 = await readAppWindow(app2Identity.pid);
    expect(finalApp2.hwnd).toBe(app2Window.hwnd);
    expect(insideDisplay2(finalApp2)).toBe(true);
    await writeFile(
      test.info().outputPath("munim-to-cua-restart-evidence.json"),
      JSON.stringify(
        {
          modelGateway: "loopback scripted gateway; external requests 0",
          realBackends: {
            first: munim,
            firstThroughSanitizingTestProxy: proxyExe,
            second: isolatedCua.path,
            secondSourceBinary: cua,
            copiedExecutableSha256: isolatedCua.executableSha256,
          },
          cuaConfigSource: "Agent Host createMcpExtension via PRSLOY_CUA_BINARY",
          launchedRealCuaProcesses: launchedCuaDrivers,
          samePackagedUserData: userData,
          firstAppPid: firstMainPid,
          secondAppPid: app2Identity.pid,
          secondAppHwnd: finalApp2.hwnd,
          fixture: { pid: fixturePid, hwnd: finalFixture.hwnd, bounds: fixtureBounds },
          durableActionAfterFirstFullClose: sanitizeRecoveryItems(pendingAfterFullClose),
          durableActionAfterSecondBackendProbe: sanitizeRecoveryItems(
            await listRecovery(launched.page),
          )?.[0],
          freshCuaSnapshotUsed: cuaGateway.freshSnapshotObtained,
          recoveryGateReportedCuaNotCalled: cuaGateway.clickRejectedByRecovery,
          CuaWrapperReportedClickDispatched: cuaGateway.wrapperReportedClickDispatched,
          rawCuaDispatchEvidence:
            "inferred from recovery-gate tool response; raw Cua stdio was not instrumented",
          sanitizedMunimProxyEvents: await readProxyEvents(proxyLog),
          initialEffectStartedOnce:
            (await readFile(delayedStart, "utf8")).trim().split(/\r?\n/u).length === 1,
          effectCompletedOnce:
            (await readFile(delayedEnd, "utf8")).trim().split(/\r?\n/u).length === 1,
        },
        null,
        2,
      ),
    );
    stage = "completed";
  } catch (error) {
    preserveFailureRoot = true;
    throw error;
  } finally {
    try {
      const readMarker = async (path: string) => await readFile(path, "utf8").catch(() => null);
      await writeFile(
        test.info().outputPath("munim-to-cua-restart-failure-evidence.json"),
        JSON.stringify(
          {
            stage,
            actionId: actionIdEvidence,
            durableBeforeFirstClose: sanitizeRecoveryItems(durableBeforeCloseEvidence),
            durableAfterFullClose: sanitizeRecoveryItems(pendingAfterFullClose),
            fixture: {
              actionStartedAt: await readMarker(delayedStart),
              actionEndedAt: await readMarker(delayedEnd),
            },
            sanitizedMunimProxyEvents: await readProxyEvents(proxyLog),
            cua: cuaGateway
              ? {
                  freshSnapshotObtained: cuaGateway.freshSnapshotObtained,
                  recoveryGateReportedCuaNotCalled: cuaGateway.clickRejectedByRecovery,
                  wrapperReportedClickDispatched: cuaGateway.wrapperReportedClickDispatched,
                  externalRequestCount: cuaGateway.externalRequestCount,
                  errors: cuaGateway.errors,
                }
              : undefined,
          },
          null,
          2,
        ),
      );
    } catch {
      test.info().annotations.push({
        type: "evidence",
        description: "Could not write sanitized cross-backend failure evidence.",
      });
    }
    let appClosed = true;
    if (launched) {
      try {
        const hostPids = await launched.app.evaluate(({ app }) =>
          app
            .getAppMetrics()
            .filter((metric) => metric.name === "PRSLOY Agent Host")
            .map((metric) => metric.pid),
        );
        for (const pid of hostPids) {
          const identity = queryProcessIdentity(pid);
          if (!identity) cleanupOk = false;
          else if (
            !appAndHostIdentities.some(
              (row) =>
                row.pid === identity.pid && row.creationUtcTicks === identity.creationUtcTicks,
            )
          )
            appAndHostIdentities.push(identity);
        }
      } catch {
        cleanupOk = false;
      }
      appClosed = await boundedCleanup(() => launched!.app.close());
      cleanupOk = (await boundedCleanup(() => launched!.fakeModel.stop())) && cleanupOk;
    }
    if (firstLaunch)
      cleanupOk = (await boundedCleanup(() => firstLaunch!.fakeModel.stop())) && cleanupOk;
    if (gateway) cleanupOk = (await boundedCleanup(() => gateway!.close())) && cleanupOk;
    if (cuaGateway) cleanupOk = (await boundedCleanup(() => cuaGateway!.close())) && cleanupOk;
    if (appClosed) {
      const noCuaDriver = isolatedCua
        ? await waitForNoNewProcesses(isolatedCua.path, cuaBaseline, 10_000).catch(() => false)
        : true;
      const noMunim = await waitForNoNewProcesses(munim!, munimBaseline, 10_000).catch(() => false);
      const noProxy = await waitForNoNewProcesses(proxyExe, proxyBaseline, 10_000).catch(
        () => false,
      );
      cleanupOk = noCuaDriver && noMunim && noProxy && cleanupOk;
      for (const identity of appAndHostIdentities)
        cleanupOk =
          (await waitForProcessIdentityGone(identity, 10_000).catch(() => false)) && cleanupOk;
    } else cleanupOk = false;
    if (fixture) {
      const exited = once(fixture, "exit").catch(() => undefined);
      if (fixture.exitCode === null && fixture.signalCode === null) fixture.kill();
      if (fixture.exitCode === null && fixture.signalCode === null)
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    }
    const fixtureGone = !fixture || fixture.exitCode !== null || fixture.signalCode !== null;
    if (cleanupOk && appClosed && fixtureGone && !preserveFailureRoot) {
      const resolvedRoot = resolve(root);
      const tempParent = resolve(tmpdir());
      if (
        dirname(resolvedRoot).toLowerCase() !== tempParent.toLowerCase() ||
        !basename(resolvedRoot).startsWith("prsloy-munim-to-cua-restart-")
      ) {
        cleanupOk = false;
      } else {
        await rm(resolvedRoot, { recursive: true, force: true }).catch(() => {
          cleanupOk = false;
        });
      }
    } else if (!preserveFailureRoot) {
      cleanupOk = false;
      test.info().annotations.push({
        type: "cleanup",
        description: "Test process did not close; retained its isolated profile.",
      });
    } else {
      test.info().annotations.push({
        type: "evidence",
        description: "Test failed; retained the isolated profile and sanitized backend evidence.",
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
type OwnedProcessIdentity = { pid: number; creationUtcTicks: string; path: string };

type RestartCuaGateway = {
  baseUrl: string;
  freshSnapshotObtained: boolean;
  clickRejectedByRecovery: boolean;
  wrapperReportedClickDispatched: boolean;
  fixtureListed: boolean;
  externalRequestCount: number;
  errors: string[];
  appPid?: number;
  appHwnd?: number;
  appNativeBaseline?: NativeWindow;
  close(): Promise<void>;
};

async function startRestartCuaGateway(options: {
  fixturePid: number;
  fixtureTitle: string;
}): Promise<RestartCuaGateway> {
  const gateway: RestartCuaGateway = {
    baseUrl: "",
    freshSnapshotObtained: false,
    clickRejectedByRecovery: false,
    wrapperReportedClickDispatched: false,
    fixtureListed: false,
    externalRequestCount: 0,
    errors: [],
    close: async () => undefined,
  };
  let targetWindowId = 0;
  const server: Server = createServer((req, res) => {
    void (async () => {
      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "zeno-fake" }] }));
        return;
      }
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        gateway.externalRequestCount += 1;
        res.writeHead(404).end();
        return;
      }
      let raw = "";
      for await (const chunk of req) raw += String(chunk);
      const body = JSON.parse(raw) as { messages?: GatewayMessage[] };
      const messages = body.messages ?? [];
      const prompt =
        messages
          .filter((m) => m.role === "user")
          .map((m) => textOf(m.content))
          .at(-1) ?? "";
      const turn = messages.slice(messages.findLastIndex((m) => m.role === "user") + 1);
      const results = turn.filter((m) => m.role === "tool");
      const lastText = textOf(results.at(-1)?.content);
      const step = results.length;
      let call: { name: string; args: Record<string, unknown> } | undefined;
      if (!prompt.includes("Cross-backend fresh Cua token probe")) {
        gateway.errors.push("unexpected_prompt");
      } else if (step === 0) {
        call = { name: "cua_list_windows", args: { pid: options.fixturePid } };
      } else if (step === 1) {
        if (!display2StillMatches())
          throw new Error("DISPLAY2 geometry changed before Cua window discovery");
        const rows = [
          ...lastText.matchAll(/\(pid\s+(\d+)\)\s+["“]([^"”]+)["”]\s+\[window_id:\s*(\d+)\]/gimu),
        ];
        if (rows.some((m) => Number(m[1]) !== options.fixturePid))
          throw new Error("PID-filtered Cua result included a foreign process");
        if (rows.length !== 1)
          throw new Error("PID-filtered Cua result did not contain exactly one fixture window row");
        const own = rows.filter(
          (m) => Number(m[1]) === options.fixturePid && m[2]?.includes(options.fixtureTitle),
        );
        if (own.length !== 1) throw new Error("Cua did not list exactly the owned fixture window");
        gateway.fixtureListed = true;
        targetWindowId = Number(own[0]![3]);
        if (!Number.isSafeInteger(targetWindowId) || targetWindowId <= 0)
          throw new Error("Cua returned an invalid fixture HWND");
        const native = await readExactWindow(options.fixturePid, options.fixtureTitle);
        if (
          native.hwnd !== targetWindowId ||
          !insideDisplay2(native) ||
          !boundsEqual(native, fixtureBounds)
        )
          throw new Error(
            "Cua target row did not match the owned fixture HWND and DISPLAY2 bounds",
          );
        if (!gateway.appPid || !gateway.appHwnd)
          throw new Error("Cua app window identity was not captured");
        const appWindow = await readAppWindow(gateway.appPid);
        if (
          !gateway.appNativeBaseline ||
          !matchesOwnedNativeWindow(appWindow, gateway.appNativeBaseline, gateway.appPid)
        )
          throw new Error("Cua app window changed from its owned DISPLAY2 target");
        call = {
          name: "cua_get_window_state",
          args: { pid: options.fixturePid, window_id: targetWindowId },
        };
      } else if (step === 2) {
        if (!display2StillMatches())
          throw new Error("DISPLAY2 geometry changed before fresh-token action");
        const currentWindow = await readExactWindow(options.fixturePid, options.fixtureTitle);
        if (
          currentWindow.hwnd !== targetWindowId ||
          !insideDisplay2(currentWindow) ||
          !boundsEqual(currentWindow, fixtureBounds)
        )
          throw new Error("Fixture HWND/PID/bounds changed before fresh-token Cua action");
        if (!gateway.appPid || !gateway.appHwnd)
          throw new Error("Cua app window identity was not captured");
        const appWindow = await readAppWindow(gateway.appPid);
        if (
          !gateway.appNativeBaseline ||
          !matchesOwnedNativeWindow(appWindow, gateway.appNativeBaseline, gateway.appPid)
        )
          throw new Error("App HWND/PID/bounds changed before fresh-token Cua action");
        const state = textOf(results.at(-1)?.content);
        const structured = [
          ...state.matchAll(
            /"element_token"\s*:\s*"(s[0-9a-f]{8}:\d+)"[^}]*"(?:name|text|label)"\s*:\s*"[^"]*Start isolated test action[^"]*"/giu,
          ),
        ];
        let token = structured[0]?.[1];
        if (!token) {
          const snapshotId = state.match(/\bs[0-9a-f]{8}\b/iu)?.[0];
          const line = state
            .split(/\r?\n/u)
            .find((item) => /Start isolated test action/iu.test(item));
          const index = line?.match(/^\s*(?:-\s*)?\[(\d+)\]/u)?.[1];
          if (snapshotId && index) token = `${snapshotId}:${index}`;
        }
        if (!token) throw new Error("Fresh Cua snapshot omitted a token for the isolated action");
        gateway.freshSnapshotObtained = true;
        call = {
          name: "cua_click",
          args: { pid: options.fixturePid, window_id: targetWindowId, element_token: token },
        };
      } else if (step === 3) {
        gateway.clickRejectedByRecovery =
          /CUA_RECOVERY_BLOCKED/u.test(lastText) &&
          /Cua не вызван|Cua was not called/iu.test(lastText);
        gateway.wrapperReportedClickDispatched =
          /clicked|click dispatched/iu.test(lastText) && !gateway.clickRejectedByRecovery;
        if (!gateway.clickRejectedByRecovery)
          throw new Error("Fresh Cua action was not rejected by the durable Munim recovery record");
      }
      await respond(res, call, step);
    })().catch((error: unknown) => {
      gateway.errors.push(error instanceof Error ? error.message : "gateway_error");
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "cross_backend_gateway_error" }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Cua loopback gateway bind failed");
  gateway.baseUrl = `http://127.0.0.1:${address.port}/v1`;
  gateway.close = async () => {
    server.closeAllConnections();
    server.close();
    await new Promise<void>((resolve) => server.once("close", resolve));
  };
  return gateway;
}

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
        assertSanitizedMunimState(resultText, options.fixturePid);
        const token = tokenForLabel(resultText, /Start isolated test action/iu);
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
  const expected = `${fixtureTitle} [fixture] pid=${pid} windows=1`;
  if (text.trim() !== expected)
    throw new Error("Sanitizing proxy did not return only the exact owned fixture row");
}
function assertSanitizedMunimState(text: string, pid: number): void {
  const lines = text.trim().split(/\r?\n/u);
  if (
    lines.length !== 3 ||
    lines[0] !== `${pid} (pid ${pid})` ||
    lines[1] !== "Ready" ||
    !/^munim_v1\.[0-9a-f-]{36}\.\d+ Button "Start isolated test action"$/u.test(lines[2] ?? "")
  )
    throw new Error("Munim sanitized state included unexpected or foreign UI content");
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
function publish(project: string, output: string, bin: string, obj: string): void {
  execFileSync(
    "dotnet",
    [
      "publish",
      project,
      "--configuration",
      "Release",
      "--output",
      output,
      "--nologo",
      "-p:BaseOutputPath=" + bin + sep,
      "-p:BaseIntermediateOutputPath=" + obj + sep,
      "-p:MSBuildProjectExtensionsPath=" + obj + sep,
    ],
    { stdio: "pipe", windowsHide: true, timeout: 60_000 },
  );
}
type SanitizedProxyEvent = {
  kind: string;
  requestId?: number;
  childPid?: number;
  proxyPid?: number;
  proxyCreationUtcTicks?: string;
  childCreationUtcTicks?: string;
  reasonCode?: string;
  realMunimPath?: string;
  proxyImagePath?: string;
  childImagePath?: string;
  utc?: string;
};
async function readProxyEvents(path: string): Promise<SanitizedProxyEvent[]> {
  const text = await readFile(path, "utf8").catch(() => "");
  return text
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SanitizedProxyEvent);
}
async function waitForProxyEvent(path: string, kind: string, timeoutMs: number): Promise<void> {
  await expect
    .poll(async () => (await readProxyEvents(path)).some((event) => event.kind === kind), {
      timeout: timeoutMs,
    })
    .toBe(true);
}
type IsolatedCuaBinary = { path: string; executableSha256: string };
async function copyPortableCuaWithUniqueName(
  sourceExecutable: string,
  destinationDirectory: string,
): Promise<IsolatedCuaBinary> {
  const sourceDirectory = dirname(sourceExecutable);
  const sourceEntries = await readdir(sourceDirectory, { withFileTypes: true });
  if (sourceEntries.length === 0 || sourceEntries.some((entry) => !entry.isFile()))
    throw new Error("Portable Cua directory must contain only its flat executable payload");
  await mkdir(destinationDirectory);
  for (const entry of sourceEntries)
    await copyFile(join(sourceDirectory, entry.name), join(destinationDirectory, entry.name));
  const uniqueName = `prsloy-cua-test-driver-${process.pid}.exe`;
  const originalName = basename(sourceExecutable);
  if (!sourceEntries.some((entry) => entry.name === originalName))
    throw new Error("Designated Cua executable is absent from its portable directory");
  const copiedOriginalPath = join(destinationDirectory, originalName);
  const copiedExecutablePath = join(destinationDirectory, uniqueName);
  await rename(copiedOriginalPath, copiedExecutablePath);
  const destinationEntries = (await readdir(destinationDirectory)).sort();
  const expectedEntries = sourceEntries
    .map((entry) => (entry.name === originalName ? uniqueName : entry.name))
    .sort();
  expect(destinationEntries).toEqual(expectedEntries);
  let executableSha256 = "";
  for (const entry of sourceEntries) {
    const original = await readFile(join(sourceDirectory, entry.name));
    const copiedName = entry.name === originalName ? uniqueName : entry.name;
    const copied = await readFile(join(destinationDirectory, copiedName));
    const originalHash = createHash("sha256").update(original).digest("hex");
    const copiedHash = createHash("sha256").update(copied).digest("hex");
    if (originalHash !== copiedHash)
      throw new Error(`Portable Cua copy hash mismatch for ${entry.name}`);
    if (entry.name === originalName) executableSha256 = copiedHash;
  }
  if (!executableSha256) throw new Error("Could not verify copied Cua executable hash");
  return { path: copiedExecutablePath, executableSha256 };
}
function assertSafeProxyLog(events: SanitizedProxyEvent[]): void {
  const allowedKeys = new Set([
    "kind",
    "requestId",
    "childPid",
    "reasonCode",
    "proxyPid",
    "proxyCreationUtcTicks",
    "proxyImagePath",
    "childCreationUtcTicks",
    "childImagePath",
    "realMunimPath",
    "utc",
  ]);
  if (
    events.length === 0 ||
    events.some((event) => Object.keys(event).some((key) => !allowedKeys.has(key)))
  )
    throw new Error("Munim proxy log is empty or contains an unapproved field");
}
function assertOwnedMunimLifecycle(
  events: SanitizedProxyEvent[],
  realMunimPath: string,
  proxyPath: string,
): void {
  const exits = events.filter(
    (event) => event.kind === "real-munim-child-exited-after-controlled-kill",
  );
  if (exits.length !== 1)
    throw new Error("Expected one controlled termination of the action's Munim child");
  const exit = exits[0]!;
  if (
    !exit.proxyPid ||
    !exit.proxyCreationUtcTicks ||
    !exit.childPid ||
    !exit.childCreationUtcTicks
  )
    throw new Error("Controlled Munim exit event omitted exact process identities");
  const sameProcessChain = events.filter(
    (event) =>
      event.proxyPid === exit.proxyPid &&
      event.proxyCreationUtcTicks === exit.proxyCreationUtcTicks &&
      event.childPid === exit.childPid &&
      event.childCreationUtcTicks === exit.childCreationUtcTicks,
  );
  const one = (kind: string): SanitizedProxyEvent => {
    const matching = sameProcessChain.filter((event) => event.kind === kind);
    if (matching.length !== 1)
      throw new Error(`Expected one ${kind} event in the killed Munim process chain`);
    return matching[0]!;
  };
  const started = one("real-munim-child-started");
  const clickAccepted = one("click-request-accepted");
  const clickForwarded = one("click-forwarded-to-real-munim");
  const effectStarted = one("fixture-action-started");
  const permitReceived = one("kill-permit-received");
  const correlated = [clickAccepted, clickForwarded, effectStarted, permitReceived, exit];
  if (correlated.some((event) => event.requestId !== exit.requestId))
    throw new Error("Munim proxy lifecycle events do not belong to the same MCP click request");
  if (
    started.childImagePath?.toLowerCase() !== resolve(realMunimPath).toLowerCase() ||
    started.realMunimPath?.toLowerCase() !== resolve(realMunimPath).toLowerCase() ||
    started.proxyImagePath?.toLowerCase() !== resolve(proxyPath).toLowerCase()
  )
    throw new Error("Killed Munim process chain did not use the designated real binaries");
}
function queryProcessIdentity(pid: number): OwnedProcessIdentity | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("invalid owned process PID");
  const script = [
    "$ErrorActionPreference='Stop'",
    `try { $p=Get-Process -Id ${pid} -ErrorAction Stop } catch { if($_.FullyQualifiedErrorId -like 'NoProcessFound*') { [Console]::Out.WriteLine('null'); exit 0 }; [Console]::Error.WriteLine('owned_process_query_failed'); exit 2 }`,
    "if(-not $p.Path -or -not $p.StartTime) { [Console]::Error.WriteLine('owned_process_identity_incomplete'); exit 3 }",
    "[pscustomobject]@{pid=$p.Id;creationUtcTicks=$p.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture);path=$p.Path} | ConvertTo-Json -Compress",
  ].join("; ");
  const output = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
  if (!output || output === "null") return undefined;
  const row = JSON.parse(output) as OwnedProcessIdentity;
  if (row.pid !== pid || !/^\d+$/u.test(row.creationUtcTicks) || !isAbsolute(row.path))
    throw new Error("owned process query returned malformed identity");
  return row;
}
function queryExactProcessIdentities(executablePath: string): OwnedProcessIdentity[] {
  const expected = resolve(executablePath);
  if (!isAbsolute(expected)) throw new Error("expected executable path must be absolute");
  const name = expected
    .split(/[\\/]/u)
    .at(-1)!
    .replace(/\.exe$/iu, "")
    .replaceAll("'", "''");
  const quotedPath = expected.replaceAll("'", "''");
  const script = [
    "$ErrorActionPreference='Stop'",
    `try { $ps=@(Get-Process -Name '${name}' -ErrorAction Stop) } catch { if($_.FullyQualifiedErrorId -like 'NoProcessFound*') { [Console]::Out.WriteLine('[]'); exit 0 }; [Console]::Error.WriteLine('owned_process_query_failed'); exit 2 }`,
    "$rows=@()",
    "foreach($p in $ps) { if($null -eq $p) { continue }; if(-not $p.Path -or -not $p.StartTime) { [Console]::Error.WriteLine('owned_process_identity_incomplete'); exit 3 }; if([string]::Equals([IO.Path]::GetFullPath($p.Path),'" +
      quotedPath +
      "',[StringComparison]::OrdinalIgnoreCase)) { $rows += [pscustomobject]@{pid=$p.Id;creationUtcTicks=$p.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture);path=$p.Path} } }",
    "$rows | ConvertTo-Json -Compress",
  ].join("; ");
  const output = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
  if (!output || output === "null") return [];
  const parsed = JSON.parse(output) as OwnedProcessIdentity | OwnedProcessIdentity[];
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  if (
    rows.some(
      (row) =>
        !Number.isSafeInteger(row.pid) ||
        !/^\d+$/u.test(row.creationUtcTicks) ||
        row.path.toLowerCase() !== expected.toLowerCase(),
    )
  )
    throw new Error("owned executable inventory returned incomplete or foreign identities");
  return rows;
}
async function waitForProcessIdentityGone(
  identity: OwnedProcessIdentity,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = queryProcessIdentity(identity.pid);
    if (
      !current ||
      current.creationUtcTicks !== identity.creationUtcTicks ||
      current.path.toLowerCase() !== identity.path.toLowerCase()
    )
      return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  return false;
}
async function waitForNoNewProcesses(
  executablePath: string,
  baseline: OwnedProcessIdentity[],
  timeoutMs: number,
): Promise<boolean> {
  const base = new Set(
    baseline.map((row) => `${row.pid}:${row.creationUtcTicks}:${row.path.toLowerCase()}`),
  );
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = queryExactProcessIdentities(executablePath);
    if (
      current.every((row) =>
        base.has(`${row.pid}:${row.creationUtcTicks}:${row.path.toLowerCase()}`),
      )
    )
      return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  return false;
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
function matchesOwnedNativeWindow(
  current: NativeWindow,
  baseline: NativeWindow,
  expectedPid: number,
): boolean {
  return (
    baseline.pid === expectedPid &&
    current.pid === expectedPid &&
    current.hwnd === baseline.hwnd &&
    boundsEqual(current, baseline) &&
    insideDisplay2(baseline) &&
    insideDisplay2(current)
  );
}
