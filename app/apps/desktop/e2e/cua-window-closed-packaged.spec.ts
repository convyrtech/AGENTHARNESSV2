import { mkdtemp, readFile, rm, mkdir, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { createServer } from "node:http";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, launchZenoApp, test } from "./fixtures.ts";

const packaged = process.env.PRSLOY_E2E_PACKAGED?.trim();
const cuaBinary = process.env.PRSLOY_CUA_BINARY?.trim();
const fixtureProject = fileURLToPath(new URL("./cua-fixture/CuaFixture.csproj", import.meta.url));
const fixtureTitle = "PRSLOY 104 Packaged Cua Fixture";
const prompt = "Read the isolated fixture, then click Save test marker once.";
const appBounds = { x: 2580, y: 500, width: 1000, height: 500 };
const fixtureBounds = { x: 2640, y: 80, width: 560, height: 340 };
const sentinelBounds = { x: 3240, y: 80, width: 560, height: 340 };

type Message = { role?: string; content?: unknown };
type WindowRow = { pid: number; window_id: number; title: string; bounds?: Bounds };
type Bounds = { x: number; y: number; width: number; height: number };
type Snapshot = { snapshot_id?: string; elements?: Record<string, unknown>[]; markdown?: string };
type PreflightEvidence = {
  stage: string;
  passed: boolean;
  target: { pid: number; hwnd: number; present: boolean; bounds?: Bounds };
  sentinel: { pid: number; hwnd: number; present: boolean; bounds?: Bounds };
  app: { pid: number; hwnd: number; present: boolean; bounds?: Bounds };
  display2Matched: boolean;
};
type Gateway = {
  baseUrl: string;
  close(): Promise<void>;
  requestCount: number;
  calls: string[];
  listWindowPidFilters: number[];
  target?: WindowRow;
  targetClosed: boolean;
  oldToken?: string;
  actionResultCategory?: "rejected" | "success-like" | "unclassified";
  rejectedAfterClose: boolean;
  errors: string[];
  done: boolean;
  validateBeforeTool(name: string, step: number): Promise<void>;
};

test("packaged CUA does not report success or retarget after its exact window closes", async () => {
  test.skip(!packaged, "requires PRSLOY_E2E_PACKAGED to point to the Windows packaged executable");
  test.skip(process.platform !== "win32", "requires native Windows UI Automation");
  test.skip(!cuaBinary, "set PRSLOY_CUA_BINARY to the verified portable Cua driver");
  test.setTimeout(240_000);

  const root = await mkdtemp(join(tmpdir(), "prsloy-cua-window-closed-"));
  const build = join(tmpdir(), `prsloy-cua-window-closed-${process.pid}-${Date.now()}`);
  const published = join(build, "publish");
  const obj = join(build, "obj");
  const bin = join(build, "bin");
  const fixtureOutput = join(root, "fixture-result.txt");
  const sentinelOutput = join(root, "sentinel-result.txt");
  const evidencePath = test.info().outputPath("cua-window-closed-packaged-evidence.json");
  let fixture: ReturnType<typeof spawn> | undefined;
  let sentinelFixture: ReturnType<typeof spawn> | undefined;
  let launched: Awaited<ReturnType<typeof launchZenoApp>> | undefined;
  let gateway: Gateway | undefined;
  let fixturePid = 0;
  let fixtureHwnd = 0;
  let sentinelPid = 0;
  let sentinelHwnd = 0;
  let appPid = 0;
  let appHwnd = 0;
  let evidence: Record<string, unknown> = {};
  let testFailure: unknown;
  let fixtureBefore: ReturnType<typeof readExactWindowInfo> | undefined;
  let sentinelBefore: ReturnType<typeof readExactWindowInfo> | undefined;
  const preflights: PreflightEvidence[] = [];
  let agentHostIdentities: Array<{ pid: number; startTicks: string }> = [];

  try {
    expect([appBounds, fixtureBounds, sentinelBounds].every(insideDisplay2)).toBe(true);
    if (!display2StillMatches()) throw new Error("DISPLAY2 geometry changed before the test");
    await mkdir(join(root, "electron-userData"), { recursive: true });
    const agentDir = join(root, "home", ".pi", "agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ extensions: ["+builtin:mcp"] }),
    );
    await writeFile(
      join(root, "electron-userData", "zeno-desktop.json"),
      JSON.stringify({ recentWorkspaces: [], window: appBounds }),
    );

    execFileSync(
      "dotnet",
      [
        "publish",
        fixtureProject,
        "-c",
        "Release",
        "-o",
        published,
        `-p:BaseOutputPath=${bin}${sep}`,
        `-p:BaseIntermediateOutputPath=${obj}${sep}`,
        `-p:MSBuildProjectExtensionsPath=${obj}${sep}`,
      ],
      { stdio: "pipe", windowsHide: true },
    );
    fixture = spawn(
      "dotnet",
      [
        join(published, "PrsloyCuaFixture.dll"),
        fixtureOutput,
        String(fixtureBounds.x),
        String(fixtureBounds.y),
      ],
      { stdio: "ignore", windowsHide: true },
    );
    if (!fixture.pid) throw new Error("Owned Cua fixture did not receive a process id");
    fixturePid = fixture.pid;
    fixtureHwnd = await waitForExactFixtureWindow(fixturePid);
    fixtureBefore = readExactWindowInfo(fixtureHwnd);
    expect(fixtureBefore.pid).toBe(fixturePid);
    expect(fixtureBefore.title).toBe(fixtureTitle);
    expect(nearBounds(fixtureBefore.bounds, fixtureBounds)).toBe(true);
    expect(insideDisplay2(fixtureBefore.bounds)).toBe(true);

    sentinelFixture = spawn(
      "dotnet",
      [
        join(published, "PrsloyCuaFixture.dll"),
        sentinelOutput,
        String(sentinelBounds.x),
        String(sentinelBounds.y),
      ],
      { stdio: "ignore", windowsHide: true },
    );
    if (!sentinelFixture.pid)
      throw new Error("Owned sentinel fixture did not receive a process id");
    sentinelPid = sentinelFixture.pid;
    sentinelHwnd = await waitForExactFixtureWindow(sentinelPid);
    sentinelBefore = readExactWindowInfo(sentinelHwnd);
    expect(sentinelBefore.pid).toBe(sentinelPid);
    expect(sentinelBefore.title).toBe(fixtureTitle);
    expect(nearBounds(sentinelBefore.bounds, sentinelBounds)).toBe(true);
    expect(insideDisplay2(sentinelBefore.bounds)).toBe(true);

    gateway = await startGateway(
      fixturePid,
      fixtureHwnd,
      async () => {
        await assertNativeState({
          stage: "immediately-before-wm-close",
          launched,
          fixture,
          fixturePid,
          fixtureHwnd,
          fixturePresent: true,
          sentinelFixture,
          sentinelPid,
          sentinelHwnd,
          appPid,
          appHwnd,
          diagnostics: preflights,
        });
        closeExactOwnedWindow(fixtureHwnd, fixturePid, fixtureTitle);
        await waitForWindowGone(fixtureHwnd);
        if (!fixture || !(await waitForChildExit(fixture, 5_000)))
          throw new Error("Owned target fixture process did not exit after WM_CLOSE");
        gateway!.targetClosed = true;
      },
      async (name, step) => {
        await assertNativeState({
          stage: `before-${name}-${step}`,
          launched,
          fixture,
          fixturePid,
          fixtureHwnd,
          fixturePresent: !gateway?.targetClosed,
          sentinelFixture,
          sentinelPid,
          sentinelHwnd,
          appPid,
          appHwnd,
          diagnostics: preflights,
        });
      },
    );
    launched = await launchZenoApp({
      root,
      tools: "read,cua_list_windows,cua_get_window_state,cua_click",
      modelBaseUrl: gateway.baseUrl,
      modelApiKey: "local-scripted-gateway-only",
      modelInput: ["text", "image"],
      env: { PRSLOY_COMPUTER_USE: "1", PRSLOY_CUA_BINARY: cuaBinary! },
    });
    const appBefore = await waitForExactAppWindow(launched);
    appHwnd = appBefore.hwnd;
    appPid = appBefore.pid;
    expect(appPid).not.toBe(fixturePid);
    expect(insideDisplay2(appBefore.bounds)).toBe(true);

    await assertNativeState({
      stage: "before-first-ui-action",
      launched,
      fixture,
      fixturePid,
      fixtureHwnd,
      fixturePresent: true,
      sentinelFixture,
      sentinelPid,
      sentinelHwnd,
      appPid,
      appHwnd,
      diagnostics: preflights,
    });
    await startHostAndSend(launched.page, prompt, async (stage) =>
      assertNativeState({
        stage,
        launched,
        fixture,
        fixturePid,
        fixtureHwnd,
        fixturePresent: true,
        sentinelFixture,
        sentinelPid,
        sentinelHwnd,
        appPid,
        appHwnd,
        diagnostics: preflights,
      }),
    );
    agentHostIdentities = await captureAgentHostIdentities(launched);
    await waitForGatewayDone(gateway, 60_000);
    await expect
      .poll(() => launched!.page.evaluate(() => window.zeno.prsloy.cuaRecovery.list()))
      .toHaveLength(1);
    await assertNativeState({
      stage: "after-stale-action-native-check",
      launched,
      fixture,
      fixturePid,
      fixtureHwnd,
      fixturePresent: false,
      sentinelFixture,
      sentinelPid,
      sentinelHwnd,
      appPid,
      appHwnd,
      diagnostics: preflights,
    });
    const recovery = await launched.page.evaluate(() => window.zeno.prsloy.cuaRecovery.list());
    expect(recovery[0]).toMatchObject({
      status: "unknown",
      pid: fixturePid,
      windowId: fixtureHwnd,
    });
    expect(gateway.calls).toEqual(["cua_list_windows", "cua_get_window_state", "cua_click"]);
    expect(gateway.listWindowPidFilters).toEqual([fixturePid]);
    expect(gateway.target).toMatchObject({
      pid: fixturePid,
      window_id: fixtureHwnd,
      title: fixtureTitle,
    });
    expect(gateway.oldToken).toMatch(/^s[0-9a-f]{8}:\d+$/u);
    expect(gateway.targetClosed).toBe(true);
    expect(gateway.rejectedAfterClose).toBe(true);
    expect(gateway.actionResultCategory).toBe("rejected");
    const appAfter = readExactWindowInfo(appHwnd);
    expect(appAfter.pid).toBe(appPid);
    expect(nearBounds(appAfter.bounds, appBefore.bounds)).toBe(true);
    const sentinelAfter = readExactWindowInfo(sentinelHwnd);
    expect(sentinelAfter.pid).toBe(sentinelPid);
    expect(sentinelAfter.title).toBe(fixtureTitle);
    expect(nearBounds(sentinelAfter.bounds, sentinelBounds)).toBe(true);
    expect(await pathExists(fixtureOutput)).toBe(false);
    expect(await pathExists(sentinelOutput)).toBe(false);
    expect(gateway.errors).toEqual([]);

    evidence = {
      packagedExecutable: packaged,
      fixtureProcess: { pid: fixturePid, hwnd: fixtureHwnd, bounds: fixtureBefore!.bounds },
      sentinelProcess: {
        pid: sentinelPid,
        hwnd: sentinelHwnd,
        boundsBefore: sentinelBefore!.bounds,
        boundsAfter: sentinelAfter.bounds,
        effectFileExists: await pathExists(sentinelOutput),
        effectFile: await readFile(sentinelOutput, "utf8").catch(() => "<absent>"),
      },
      appWindow: {
        pid: appPid,
        hwnd: appHwnd,
        boundsBefore: appBefore.bounds,
        boundsAfter: appAfter.bounds,
      },
      scriptedGateway: true,
      networkOrModelProviderUsed: false,
      targetClosedAfterSnapshotBeforeAction: gateway.targetClosed,
      oldSnapshotTokenUsed: gateway.oldToken,
      exactToolCalls: gateway.calls,
      listWindowPidFilters: gateway.listWindowPidFilters,
      actionRejectedAsAmbiguous: gateway.rejectedAfterClose,
      recoveryRecord: {
        pid: recovery[0]!.pid,
        windowId: recovery[0]!.windowId,
        kind: recovery[0]!.kind,
        status: recovery[0]!.status,
      },
      fixtureEffectFileExists: await pathExists(fixtureOutput),
      fixtureEffectFile: await readFile(fixtureOutput, "utf8").catch(() => "<absent>"),
      gatewayErrors: gateway.errors,
      preflights,
      completed: true,
    };
  } catch (error) {
    testFailure = error;
  } finally {
    let cleanupFailure: string | undefined;
    const cleanup: Record<string, boolean> = {};

    if (launched) {
      const appProcess = launched.app.process();
      if (!agentHostIdentities.length) {
        try {
          agentHostIdentities = await captureAgentHostIdentities(launched);
        } catch {
          cleanupFailure = "could not identify owned Agent Host children";
        }
      }
      const closeResolved = await boundedCleanup(() => launched!.app.close(), 10_000);
      cleanup.electronCloseResolved = closeResolved;
      let appExited = await waitForChildExit(appProcess, 10_000);
      if (!appExited && appProcess.exitCode === null && appProcess.signalCode === null) {
        try {
          appProcess.kill();
        } catch {
          /* The exact Playwright-owned child handle was targeted. */
        }
        appExited = await waitForChildExit(appProcess, 5_000);
      }
      cleanup.electronExited = appExited;
      if (!closeResolved) cleanupFailure ??= "owned packaged Electron close timed out or failed";
      if (!appExited) cleanupFailure ??= "owned packaged Electron process did not exit";
      cleanup.fakeModelStopped = await boundedCleanup(() => launched!.fakeModel.stop(), 5_000);
      if (!cleanup.fakeModelStopped) cleanupFailure ??= "local fake model did not close";
      cleanup.agentHostsExited =
        !agentHostIdentities.length || (await waitForIdentitiesGone(agentHostIdentities, 8_000));
      if (!cleanup.agentHostsExited)
        cleanupFailure ??= "owned Agent Host process remained after Electron shutdown";
    }
    cleanup.gatewayClosed = !gateway || (await boundedCleanup(() => gateway!.close(), 5_000));
    if (!cleanup.gatewayClosed) cleanupFailure ??= "loopback gateway did not close";
    cleanup.targetFixtureExited = !fixture || (await stopOwnedFixture(fixture, 5_000));
    if (!cleanup.targetFixtureExited)
      cleanupFailure ??= "owned target fixture process did not exit";
    cleanup.sentinelFixtureExited =
      !sentinelFixture || (await stopOwnedFixture(sentinelFixture, 5_000));
    if (!cleanup.sentinelFixtureExited)
      cleanupFailure ??= "owned sentinel fixture process did not exit";

    try {
      await writeFile(
        evidencePath,
        JSON.stringify(
          {
            ...evidence,
            packagedExecutable: packaged,
            fixturePid,
            fixtureHwnd,
            sentinelPid,
            sentinelHwnd,
            appPid,
            appHwnd,
            calls: gateway?.calls ?? [],
            listWindowPidFilters: gateway?.listWindowPidFilters ?? [],
            targetClosed: gateway?.targetClosed ?? false,
            oldToken: gateway?.oldToken,
            actionResultCategory: gateway?.actionResultCategory,
            rejectedAfterClose: gateway?.rejectedAfterClose ?? false,
            gatewayErrors: gateway?.errors ?? [],
            preflights,
            cleanup,
            cleanupFailure,
            completed: evidence.completed === true,
          },
          null,
          2,
        ),
      );
    } catch {
      cleanupFailure ??= "could not write sanitized evidence";
    }

    if (cleanupFailure || testFailure) {
      const failure =
        cleanupFailure ??
        (testFailure instanceof Error ? testFailure.message : String(testFailure));
      testFailure = new Error(
        `${failure}; preserving isolated profile and build at ${root} and ${build}; evidence: ${evidencePath}`,
      );
    } else {
      try {
        await rm(root, { recursive: true, force: true });
        await rm(build, { recursive: true, force: true });
      } catch {
        testFailure ??= new Error(
          `Could not remove isolated profile/build; inspect ${root} and ${build}`,
        );
      }
    }
  }
  if (testFailure) throw testFailure;
});

async function startGateway(
  fixturePid: number,
  fixtureHwnd: number,
  closeTarget: () => Promise<void>,
  validateBeforeTool: (name: string, step: number) => Promise<void>,
): Promise<Gateway> {
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "zeno-fake" }] }));
        return;
      }
      if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
        res.writeHead(404).end();
        return;
      }
      let raw = "";
      for await (const chunk of req) raw += String(chunk);
      const body = JSON.parse(raw) as { messages?: Message[] };
      const current = body.messages ?? [];
      gateway.requestCount += 1;
      const userIndex = current.findLastIndex(
        (message) => message.role === "user" && allText(message.content).includes(prompt),
      );
      const results = current.slice(userIndex + 1).filter((message) => message.role === "tool");
      const step = results.length;
      const last = results.at(-1);
      const resultText = allText(last?.content);
      let next: { name: string; args: Record<string, unknown> } | undefined;

      if (step === 0) next = { name: "cua_list_windows", args: { pid: fixturePid } };
      else if (step === 1) {
        const windows = parseWindows(last?.content);
        if (windows.some((window) => window.pid !== fixturePid))
          throw new Error("PID-filtered Cua list returned an unrelated process");
        const target = windows.find(
          (window) =>
            window.pid === fixturePid &&
            window.window_id === fixtureHwnd &&
            window.title === fixtureTitle,
        );
        if (!target) throw new Error("Exact owned fixture HWND missing from Cua list");
        const native = readExactWindowInfo(target.window_id);
        if (
          native.pid !== fixturePid ||
          native.title !== fixtureTitle ||
          !insideDisplay2(native.bounds)
        )
          throw new Error("Target HWND identity or DISPLAY2 preflight failed");
        gateway.target = target;
        next = { name: "cua_get_window_state", args: { pid: fixturePid, window_id: fixtureHwnd } };
      } else if (step === 2) {
        const snapshot = extractSnapshot(last?.content);
        const closeToken = findElementToken(snapshot, /save test marker|fixtureSave/iu);
        gateway.oldToken = closeToken;
        await closeTarget();
        next = {
          name: "cua_click",
          args: { pid: fixturePid, window_id: fixtureHwnd, element_token: closeToken },
        };
      } else if (step === 3) {
        const successLike = /effect.*confirmed|click.*succeeded|успешно выполн/iu.test(resultText);
        const explicitFailure =
          /unknown|error|failed|not found|closed|exception|invalid|no element|could not|cannot|неизвест|ошиб|не найден|закрыт|не удалось|не существует/iu.test(
            resultText,
          );
        gateway.actionResultCategory = successLike
          ? "success-like"
          : explicitFailure
            ? "rejected"
            : "unclassified";
        gateway.rejectedAfterClose = gateway.actionResultCategory === "rejected";
        if (!gateway.rejectedAfterClose)
          throw new Error("Old token action was not explicitly rejected");
        gateway.done = true;
      } else if (step === 4) {
        throw new Error("Unexpected fourth CUA tool result");
      } else throw new Error(`Unexpected scripted gateway step ${step}`);

      if (next) await validateBeforeTool(next.name, step);
      if (next?.name === "cua_list_windows") {
        if (next.args.pid !== fixturePid)
          throw new Error("Refusing CUA list_windows without the owned fixture PID filter");
        gateway.listWindowPidFilters.push(fixturePid);
      }
      gateway.calls.push(...(next ? [next.name] : []));
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const send = (delta: Record<string, unknown>, finish: string | null = null) =>
        res.write(
          `data: ${JSON.stringify({ id: "cua-window-closed-e2e", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        );
      send({ role: "assistant", content: "" });
      if (next) {
        send({
          tool_calls: [
            {
              index: 0,
              id: `cua-window-closed-${step}`,
              type: "function",
              function: { name: next.name, arguments: JSON.stringify(next.args) },
            },
          ],
        });
        send({}, "tool_calls");
      } else {
        send({
          content:
            "The previously identified fixture window closed before the click; the old token was rejected and no other window was selected.",
        });
        send({}, "stop");
      }
      res.end("data: [DONE]\n\n");
    })().catch((error) => {
      gateway.errors.push(error instanceof Error ? error.name : "non-error");
      if (!res.writableEnded && !res.destroyed) {
        if (!res.headersSent)
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(
          `data: ${JSON.stringify({ id: "cua-window-closed-fail-fast", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "The isolated CUA test stopped safely after a gateway error." }, finish_reason: null }] })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ id: "cua-window-closed-fail-fast", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
        );
        res.end("data: [DONE]\n\n");
      }
    });
  });
  const gateway = Object.assign(
    {
      requestCount: 0,
      calls: [] as string[],
      listWindowPidFilters: [] as number[],
      targetClosed: false,
      rejectedAfterClose: false,
      errors: [] as string[],
      done: false,
      validateBeforeTool,
    },
    {
      close: async () => {
        server.closeAllConnections();
        server.close();
        await new Promise<void>((resolve) => server.once("close", resolve));
      },
    },
  ) as Gateway;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Scripted gateway failed to bind loopback");
  gateway.baseUrl = `http://127.0.0.1:${address.port}/v1`;
  return gateway;
}

async function startHostAndSend(
  page: import("playwright").Page,
  userPrompt: string,
  preflight: (stage: string) => Promise<void>,
): Promise<void> {
  await page.getByTestId("zeno-app").waitFor({ state: "visible" });
  await page.waitForSelector('[data-testid="zeno-app"][data-bootstrap-ready="true"]', {
    timeout: 120_000,
  });
  const trust = page.getByTestId("project-trust-dialog-trust");
  if (await trust.isVisible().catch(() => false)) {
    await preflight("before-trust-click");
    await trust.click();
  }
  const snapshot = page.getByTestId("runtime-snapshot").first();
  if (!/"runtimeId":\s*"([^"]+)"/u.test((await snapshot.textContent().catch(() => "")) ?? "")) {
    await preflight("before-start-host-click");
    await page.getByTestId("start-host").click({ force: true });
    if (await trust.isVisible().catch(() => false)) {
      await preflight("before-post-start-trust-click");
      await trust.click();
    }
    await expect(snapshot).toContainText("runtimeId", { timeout: 60_000 });
  }
  await expect(page.getByTestId("host-status").first()).toContainText(
    /Agent Host ready|Agent Host restarted|Agent settled|就绪/u,
    { timeout: 45_000 },
  );
  await preflight("before-prompt-fill");
  await page.getByTestId("prompt-input").fill(userPrompt);
  await preflight("before-prompt-send");
  await page.getByTestId("send-prompt").click();
}

async function waitForGatewayDone(gateway: Gateway, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (gateway.errors.length) throw new Error(`Scripted gateway failed: ${gateway.errors[0]}`);
    if (gateway.done) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (gateway.errors.length) throw new Error(`Scripted gateway failed: ${gateway.errors[0]}`);
  throw new Error("Timed out waiting for the isolated scripted gateway");
}

async function assertNativeState(options: {
  stage: string;
  launched: Awaited<ReturnType<typeof launchZenoApp>> | undefined;
  fixture: ChildProcess | undefined;
  fixturePid: number;
  fixtureHwnd: number;
  fixturePresent: boolean;
  sentinelFixture: ChildProcess | undefined;
  sentinelPid: number;
  sentinelHwnd: number;
  appPid: number;
  appHwnd: number;
  diagnostics: PreflightEvidence[];
}): Promise<void> {
  const display2Matched = display2StillMatches();
  const fixtureAlive = isChildAlive(options.fixture);
  const sentinelAlive = isChildAlive(options.sentinelFixture);
  let targetPresent = false;
  let sentinelPresent = false;
  let appPresent = false;
  let targetBounds: Bounds | undefined;
  let sentinelObservedBounds: Bounds | undefined;
  let appObservedBounds: Bounds | undefined;
  if (options.fixturePresent && fixtureAlive) {
    try {
      const native = readExactWindowInfo(options.fixtureHwnd);
      if (native.pid === options.fixturePid) targetBounds = native.bounds;
      targetPresent =
        native.pid === options.fixturePid &&
        native.title === fixtureTitle &&
        nearBounds(native.bounds, fixtureBounds) &&
        insideDisplay2(native.bounds);
    } catch {
      targetPresent = false;
    }
  } else if (!options.fixturePresent) {
    targetPresent = !fixtureAlive && !(await windowExists(options.fixtureHwnd));
  }
  if (sentinelAlive) {
    try {
      const native = readExactWindowInfo(options.sentinelHwnd);
      if (native.pid === options.sentinelPid) sentinelObservedBounds = native.bounds;
      sentinelPresent =
        native.pid === options.sentinelPid &&
        native.title === fixtureTitle &&
        nearBounds(native.bounds, sentinelBounds) &&
        insideDisplay2(native.bounds);
    } catch {
      sentinelPresent = false;
    }
  }
  if (options.launched && isChildAlive(options.launched.app.process())) {
    try {
      const electron = await options.launched.app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        const handle = window?.getNativeWindowHandle();
        return window && handle?.length
          ? { pid: process.pid, hwnd: Number(handle.readBigUInt64LE()), bounds: window.getBounds() }
          : undefined;
      });
      const native = readExactWindowInfo(options.appHwnd);
      if (native.pid === options.appPid) appObservedBounds = native.bounds;
      appPresent = Boolean(
        electron &&
        electron.pid === options.appPid &&
        electron.hwnd === options.appHwnd &&
        boundsEqual(electron.bounds, appBounds) &&
        native.pid === options.appPid &&
        insideDisplay2(native.bounds),
      );
    } catch {
      appPresent = false;
    }
  }
  const passed = display2Matched && targetPresent && sentinelPresent && appPresent;
  options.diagnostics.push({
    stage: options.stage,
    passed,
    target: {
      pid: options.fixturePid,
      hwnd: options.fixtureHwnd,
      present: targetPresent,
      ...(targetBounds ? { bounds: targetBounds } : {}),
    },
    sentinel: {
      pid: options.sentinelPid,
      hwnd: options.sentinelHwnd,
      present: sentinelPresent,
      ...(sentinelObservedBounds ? { bounds: sentinelObservedBounds } : {}),
    },
    app: {
      pid: options.appPid,
      hwnd: options.appHwnd,
      present: appPresent,
      ...(appObservedBounds ? { bounds: appObservedBounds } : {}),
    },
    display2Matched,
  });
  if (!passed) throw new Error(`Native PID/HWND/bounds preflight failed at ${options.stage}`);
}

function isChildAlive(child: ChildProcess | undefined): boolean {
  return Boolean(child && child.exitCode === null && child.signalCode === null);
}

async function waitForExactAppWindow(
  launched: Awaited<ReturnType<typeof launchZenoApp>>,
): Promise<{ pid: number; hwnd: number; bounds: Bounds }> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (!display2StillMatches())
      throw new Error("DISPLAY2 geometry changed while waiting for packaged HWND");
    const electron = await launched.app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const handle = window?.getNativeWindowHandle();
      return window && handle?.length
        ? { pid: process.pid, hwnd: Number(handle.readBigUInt64LE()), bounds: window.getBounds() }
        : undefined;
    });
    if (electron && boundsEqual(electron.bounds, appBounds) && insideDisplay2(electron.bounds)) {
      const native = readExactWindowInfo(electron.hwnd);
      if (native.pid === electron.pid && insideDisplay2(native.bounds))
        return { pid: native.pid, hwnd: electron.hwnd, bounds: native.bounds };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Packaged PRSLOY did not produce its expected native DISPLAY2 window");
}

async function windowExists(hwnd: number): Promise<boolean> {
  const source = `using System; using System.Runtime.InteropServices; public static class PrsloyWindowPresence { [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h); public static bool Exists(long h) { return IsWindow(new IntPtr(h)); } }`;
  const script = `Add-Type -TypeDefinition @'\n${source}\n'@; [PrsloyWindowPresence]::Exists(${hwnd})`;
  const output = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  return output.toLowerCase() === "true";
}

async function captureAgentHostIdentities(
  launched: Awaited<ReturnType<typeof launchZenoApp>>,
): Promise<Array<{ pid: number; startTicks: string }>> {
  const pids = await launched.app.evaluate(({ app }) =>
    app
      .getAppMetrics()
      .filter((metric) => metric.name === "PRSLOY Agent Host")
      .map((metric) => metric.pid),
  );
  const identities: Array<{ pid: number; startTicks: string }> = [];
  for (const pid of pids) {
    const startTicks = readProcessStartTicks(pid);
    if (startTicks !== undefined) identities.push({ pid, startTicks });
  }
  return identities;
}

function readProcessStartTicks(pid: number): string | undefined {
  try {
    const output = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
      ],
      { encoding: "utf8", windowsHide: true },
    ).trim();
    return /^\d+$/u.test(output) ? output : undefined;
  } catch {
    return undefined;
  }
}

async function waitForIdentitiesGone(
  identities: Array<{ pid: number; startTicks: string }>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const stillAlive = identities.some(
      (identity) => readProcessStartTicks(identity.pid) === identity.startTicks,
    );
    if (!stillAlive) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return !identities.some(
    (identity) => readProcessStartTicks(identity.pid) === identity.startTicks,
  );
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise<boolean>((resolve) => {
    const finish = (value: boolean) => {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) finish(true);
  });
}

async function stopOwnedFixture(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (!isChildAlive(child)) return true;
  try {
    child.kill();
  } catch {
    // A failed signal is followed by a bounded, explicit exit check below.
  }
  return await waitForChildExit(child, timeoutMs);
}

async function boundedCleanup(
  operation: () => Promise<unknown>,
  timeoutMs: number,
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

function allText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(allText).join("\n");
  if (value && typeof value === "object")
    return Object.values(value as Record<string, unknown>)
      .map(allText)
      .join("\n");
  return "";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
}

function allObjects(
  value: unknown,
  out: Record<string, unknown>[] = [],
): Record<string, unknown>[] {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed !== value) allObjects(parsed, out);
    } catch {
      // Plain accessibility text is handled by the Markdown window-list fallback.
    }
  }
  if (Array.isArray(value)) for (const item of value) allObjects(item, out);
  else if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    out.push(row);
    for (const nested of Object.values(row)) allObjects(nested, out);
  }
  return out;
}

function parseWindows(content: unknown): WindowRow[] {
  const rows: WindowRow[] = [];
  for (const row of allObjects(content)) {
    const pid = row.pid;
    const hwnd = row.window_id ?? row.windowId;
    const title = row.title ?? row.window_title;
    const bounds = row.bounds as Record<string, unknown> | undefined;
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(hwnd) || typeof title !== "string")
      continue;
    rows.push({
      pid: Number(pid),
      window_id: Number(hwnd),
      title,
      ...(bounds && [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
        ? {
            bounds: {
              x: Number(bounds.x),
              y: Number(bounds.y),
              width: Number(bounds.width),
              height: Number(bounds.height),
            },
          }
        : {}),
    });
  }
  const listedText = allText(content).replace(/\\(["\\])/gu, "$1");
  const listedWindow = /\(pid\s+(\d+)\)\s+["“]([^"”]+)["”]\s+\[window_id:\s*(\d+)\]/gimu;
  for (const match of listedText.matchAll(listedWindow)) {
    const pid = Number(match[1]);
    const title = match[2];
    const hwnd = Number(match[3]);
    if (
      Number.isSafeInteger(pid) &&
      Number.isSafeInteger(hwnd) &&
      title &&
      !rows.some((row) => row.pid === pid && row.window_id === hwnd)
    )
      rows.push({ pid, window_id: hwnd, title });
  }
  return rows;
}

function extractSnapshot(content: unknown): Snapshot {
  const objects = allObjects(content);
  const row = objects.find((candidate) => typeof candidate.snapshot_id === "string");
  const snapshot: Snapshot = {
    markdown: allText(content),
    ...(row ? { snapshot_id: String(row.snapshot_id) } : {}),
  };
  const elements = objects.find((candidate) => Array.isArray(candidate.elements))?.elements;
  if (Array.isArray(elements)) snapshot.elements = elements as Record<string, unknown>[];
  if (!snapshot.snapshot_id) {
    const id = allText(content).match(/\bs[0-9a-f]{8}\b/iu)?.[0];
    if (id) snapshot.snapshot_id = id;
  }
  return snapshot;
}

function findElementToken(snapshot: Snapshot, label: RegExp): string {
  const found = snapshot.elements?.find(
    (row) => typeof row.element_token === "string" && label.test(JSON.stringify(row)),
  );
  if (typeof found?.element_token === "string") return found.element_token;
  const line = (snapshot.markdown ?? "").split(/\r?\n/u).find((candidate) => label.test(candidate));
  const index = line?.match(/^\s*(?:-\s*)?\[(\d+)\]/u)?.[1];
  if (snapshot.snapshot_id && index) return `${snapshot.snapshot_id}:${index}`;
  throw new Error(`Snapshot did not contain a fresh token for ${label}`);
}

function insideDisplay2(bounds: Bounds): boolean {
  return (
    bounds.x >= 2560 &&
    bounds.y >= 0 &&
    bounds.x + bounds.width <= 4480 &&
    bounds.y + bounds.height <= 1080
  );
}

function nearBounds(actual: Bounds, expected: Bounds): boolean {
  return (
    Math.abs(actual.x - expected.x) <= 10 &&
    Math.abs(actual.y - expected.y) <= 10 &&
    Math.abs(actual.width - expected.width) <= 10 &&
    Math.abs(actual.height - expected.height) <= 10
  );
}

function boundsEqual(actual: Bounds, expected: Bounds): boolean {
  return (
    actual.x === expected.x &&
    actual.y === expected.y &&
    actual.width === expected.width &&
    actual.height === expected.height
  );
}

function display2StillMatches(): boolean {
  const script =
    "$s = [System.Windows.Forms.Screen]::AllScreens | Where-Object { $_.DeviceName -eq '\\\\.\\DISPLAY2' -and -not $_.Primary }; if (-not $s) { exit 2 }; $s.Bounds | ConvertTo-Json -Compress";
  try {
    const output = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", `Add-Type -AssemblyName System.Windows.Forms; ${script}`],
      { encoding: "utf8", windowsHide: true },
    ).trim();
    const bounds = JSON.parse(output) as { X: number; Y: number; Width: number; Height: number };
    return bounds.X === 2560 && bounds.Y === 0 && bounds.Width === 1920 && bounds.Height === 1080;
  } catch {
    return false;
  }
}

function readExactWindowInfo(hwnd: number): { pid: number; title: string; bounds: Bounds } {
  const source = `using System; using System.Runtime.InteropServices; using System.Text; public static class PrsloyCloseWindowProbe { [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; } [DllImport("user32.dll", SetLastError=true)] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid); [DllImport("user32.dll", SetLastError=true)] static extern bool GetWindowRect(IntPtr h, out RECT r); [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n); public static object Read(long hwnd) { uint pid; var h=new IntPtr(hwnd); if(GetWindowThreadProcessId(h,out pid)==0) throw new Exception("invalid HWND"); RECT r; if(!GetWindowRect(h,out r)) throw new Exception("GetWindowRect failed"); var t=new StringBuilder(512); GetWindowText(h,t,t.Capacity); return new object[]{(int)pid,t.ToString(),r.Left,r.Top,r.Right-r.Left,r.Bottom-r.Top}; } }`;
  const output = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `Add-Type -TypeDefinition @'\n${source}\n'@; [PrsloyCloseWindowProbe]::Read(${hwnd}) | ConvertTo-Json -Compress`,
    ],
    { encoding: "utf8", windowsHide: true },
  ).trim();
  const row = JSON.parse(output) as [number, string, number, number, number, number];
  if (
    row.length !== 6 ||
    !row.every((value, index) => (index === 1 ? typeof value === "string" : Number.isFinite(value)))
  )
    throw new Error("Native HWND identity read failed");
  return {
    pid: row[0],
    title: row[1],
    bounds: { x: row[2], y: row[3], width: row[4], height: row[5] },
  };
}

async function waitForExactFixtureWindow(pid: number): Promise<number> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const output = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty MainWindowHandle`,
      ],
      { encoding: "utf8", windowsHide: true },
    ).trim();
    const hwnd = Number(output);
    if (Number.isSafeInteger(hwnd) && hwnd > 0) {
      const info = readExactWindowInfo(hwnd);
      if (info.pid === pid && info.title === fixtureTitle && insideDisplay2(info.bounds))
        return hwnd;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Owned fixture did not produce its expected DISPLAY2 HWND");
}

function closeExactOwnedWindow(hwnd: number, pid: number, title: string): void {
  const source = `using System; using System.Runtime.InteropServices; using System.Text; public static class PrsloyCloseOwnedWindow { [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; } [DllImport("user32.dll", SetLastError=true)] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid); [DllImport("user32.dll", SetLastError=true)] static extern bool GetWindowRect(IntPtr h, out RECT r); [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n); [DllImport("user32.dll", SetLastError=true)] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l); public static int Close(long raw, int expectedPid, string expectedTitle) { var h=new IntPtr(raw); uint pid; if(GetWindowThreadProcessId(h,out pid)==0 || pid!=expectedPid) throw new Exception("refusing HWND with different PID"); var title=new StringBuilder(512); GetWindowText(h,title,title.Capacity); if(title.ToString()!=expectedTitle) throw new Exception("refusing HWND with different title"); RECT r; if(!GetWindowRect(h,out r) || r.Left<2560 || r.Top<0 || r.Right>4480 || r.Bottom>1080) throw new Exception("refusing HWND outside DISPLAY2"); if(!PostMessage(h,0x0010,IntPtr.Zero,IntPtr.Zero)) throw new Exception("WM_CLOSE failed: "+Marshal.GetLastWin32Error()); return (int)pid; } }`;
  const escapedTitle = title.replaceAll("'", "''");
  const script = `Add-Type -TypeDefinition @'\n${source}\n'@; [PrsloyCloseOwnedWindow]::Close(${hwnd}, ${pid}, '${escapedTitle}')`;
  const closedPid = Number(
    execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
    }).trim(),
  );
  if (closedPid !== pid) throw new Error("WM_CLOSE was not acknowledged for the owned PID");
}

async function waitForWindowGone(hwnd: number): Promise<void> {
  const source = `using System; using System.Runtime.InteropServices; public static class PrsloyWindowGone { [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h); public static bool Exists(long h) { return IsWindow(new IntPtr(h)); } }`;
  const script = `Add-Type -TypeDefinition @'\n${source}\n'@; [PrsloyWindowGone]::Exists(${hwnd})`;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const output = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
    }).trim();
    if (output.toLowerCase() === "false") return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Target HWND remained alive after WM_CLOSE");
}
