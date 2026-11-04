import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { createServer, type Server, type ServerResponse } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, launchZenoApp, test, waitSettled } from "./fixtures.ts";
import {
  eventsShareProcessChain,
  normalizeUserTextContent,
  noNewOwnedProcessesRemain,
  parseFixtureButtonToken,
  proxyLifecycleIsVerified,
  type OwnedProcessIdentity,
} from "./munim-backend-failure-protocol.ts";

const packaged = process.env.PRSLOY_E2E_PACKAGED?.trim();
const realMunim = process.env.PRSLOY_MUNIM_BINARY?.trim();
const fixtureProject = fileURLToPath(
  new URL("./munim-backend-failure-fixture/MunimBackendFailureFixture.csproj", import.meta.url),
);
const proxyProject = fileURLToPath(
  new URL("./munim-backend-failure-proxy/MunimBackendFailureProxy.csproj", import.meta.url),
);
const fixtureBounds = { x: 2640, y: 80, width: 600, height: 300 };
const appBounds = { x: 2580, y: 500, width: 1000, height: 500 };
type FixtureIdentity = {
  pid: number;
  hwnd: number;
  x: number;
  y: number;
  width: number;
  height: number;
};
type NativeWindowInfo = {
  pid: number;
  title: string;
  bounds: { x: number; y: number; width: number; height: number };
};
type ActionRow = { actionId: string; status: string; backend: string; pid: number; kind: string };
type ModelMessage = {
  role?: string;
  content?: unknown;
  tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
};

test("packaged PRSLOY records real Munim child loss during a started fixture action and blocks retry", async () => {
  test.skip(!packaged, "requires a packaged Windows PRSLOY executable");
  test.skip(!realMunim, "requires the locally installed real Munim executable");
  test.skip(process.platform !== "win32", "requires Windows UIA and DISPLAY2");
  test.setTimeout(240_000);
  assertDisplay2();

  const root = await mkdtemp(join(tmpdir(), "prsloy-munim-backend-failure-"));
  const publishedFixture = join(root, "fixture-published");
  const fixtureBuild = join(root, "fixture-build");
  const proxyBuild = join(root, "proxy-build");
  const proxyDir = join(root, "test-proxy");
  const proxyExe = join(proxyDir, "munim-computer-use.exe");
  const userData = join(root, "electron-userData");
  const workspace = join(root, "workspace");
  const identityPath = join(root, "fixture-identity.json");
  const startSentinel = join(root, "action.started");
  const endSentinel = join(root, "action.ended");
  const killPermit = join(root, "kill-after-dispatching.permit");
  const proxyLog = join(root, "proxy-evidence.jsonl");
  const fixtureDll = join(publishedFixture, "PrsloyMunimBackendFailureFixture.dll");
  const fixtureTitle = "PRSLOY Backend Failure Fixture";
  const marker = `PRSLOY-BACKEND-FAILURE-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  let fixture: ReturnType<typeof spawn> | undefined;
  let launched: Awaited<ReturnType<typeof launchZenoApp>> | undefined;
  let gateway: LocalFailureGateway | undefined;
  let cleanupOk = true;
  let keepProfile = false;
  let fixtureIdentity: FixtureIdentity | undefined;
  let appPid = 0;
  let appHwnd = 0;
  let appTitle = "";
  let appBoundsBefore = { x: 0, y: 0, width: 0, height: 0 };
  let hostBefore: { pid: number; creationTime: number } | undefined;
  let ownedProcessBaseline: OwnedProcessIdentity[] | undefined;
  let hostMayHaveStarted = false;
  let durableDispatching: ActionRow | undefined;
  let stage = "setup";
  let failureObserved = false;

  try {
    await Promise.all([
      mkdir(publishedFixture, { recursive: true }),
      mkdir(proxyDir, { recursive: true }),
      mkdir(userData, { recursive: true }),
      mkdir(workspace, { recursive: true }),
    ]);
    await writeFile(
      join(userData, "zeno-desktop.json"),
      JSON.stringify({ recentWorkspaces: [], window: appBounds }),
    );
    await writeFile(join(workspace, "README.md"), "Synthetic UI fixture. No user content.\n");

    publish(fixtureProject, publishedFixture, fixtureBuild);
    publish(proxyProject, proxyDir, proxyBuild);
    const proxyConfigPath = join(proxyDir, "munim-backend-failure.json");
    if (!realMunim || !isAbsoluteFile(realMunim))
      throw new Error("Real Munim path must be absolute");

    stage = "fixture-startup";
    fixture = spawn(
      "dotnet",
      [fixtureDll, identityPath, startSentinel, endSentinel, String(fixtureBounds.x)],
      { stdio: "ignore", windowsHide: true },
    );
    if (!fixture.pid) throw new Error("Isolated UI fixture did not start");
    fixtureIdentity = await waitForFixtureIdentity(identityPath, fixture.pid);
    assertFixtureIdentity(fixtureIdentity, fixtureTitle);
    await writeFile(
      proxyConfigPath,
      JSON.stringify({
        target: realMunim,
        log: proxyLog,
        startSentinel,
        endSentinel,
        killPermit,
        fixturePid: fixture.pid,
        fixtureHwnd: fixtureIdentity.hwnd,
        fixtureTitle,
        fixtureX: fixtureIdentity.x,
        fixtureY: fixtureIdentity.y,
        fixtureWidth: fixtureIdentity.width,
        fixtureHeight: fixtureIdentity.height,
      }),
    );
    stage = "gateway-startup";
    gateway = await startLocalFailureGateway(fixture.pid, marker);

    const expectedProcessImages = [proxyExe, realMunim];
    ownedProcessBaseline = queryOwnedProcessIdentities(expectedProcessImages);

    stage = "packaged-app-startup";
    launched = await launchZenoApp({
      root,
      workspacePath: workspace,
      tools: "read,munim_list_apps,munim_get_app_state,munim_click",
      modelInput: ["text"],
      modelBaseUrl: gateway.baseUrl,
      modelApiKey: "local-test-only",
      env: { PRSLOY_COMPUTER_USE: "1", PRSLOY_MUNIM_BINARY: proxyExe, PRSLOY_CUA_BINARY: "" },
    });
    await launched.fakeModel.stop();
    const mcp = JSON.parse(await readFile(join(launched.agentDir, "mcp.json"), "utf8")) as {
      mcpServers?: Record<string, { command?: string; args?: unknown[] }>;
    };
    expect(mcp.mcpServers?.munimComputerUse?.command).toBe(proxyExe);
    expect(mcp.mcpServers?.munimComputerUse?.args).toEqual([]);
    const models = JSON.parse(await readFile(join(launched.agentDir, "models.json"), "utf8")) as {
      providers?: Record<string, { baseUrl?: string }>;
    };
    expect(models.providers?.["zeno-fake"]?.baseUrl).toBe(gateway.baseUrl);
    expect(await launched.app.evaluate(({ app }) => app.getPath("userData"))).toBe(userData);

    await launched.page.waitForSelector('[data-testid="zeno-app"][data-bootstrap-ready="true"]', {
      timeout: 90_000,
    });
    const initialApp = await readElectronWindow(launched);
    appPid = initialApp.pid;
    appHwnd = initialApp.hwnd;
    appBoundsBefore = initialApp.bounds;
    const initialAppNative = readExactWindowInfo(appHwnd);
    appTitle = initialAppNative.title;
    if (
      appPid <= 0 ||
      !appHwnd ||
      !appTitle ||
      JSON.stringify(appBoundsBefore) !== JSON.stringify(appBounds) ||
      initialAppNative.pid !== appPid ||
      !insideDisplay2(initialAppNative.bounds)
    )
      throw new Error(
        "Initial packaged app HWND/PID/native bounds are not the intended DISPLAY2 target",
      );
    stage = "host-readiness";
    const runtime = launched.page.getByTestId("runtime-snapshot").first();
    const runtimeWasPresent = /"runtimeId":\s*"([^"]+)"/u.test(
      (await runtime.textContent().catch(() => "")) ?? "",
    );
    hostMayHaveStarted = runtimeWasPresent;
    if (!runtimeWasPresent) {
      hostMayHaveStarted = true;
      await assertLiveTargets(
        "before-start-host-click",
        launched,
        fixture,
        fixtureIdentity!,
        appPid,
        appHwnd,
        appTitle,
      );
      await launched.page.getByTestId("start-host").click({ force: true });
      await expect(runtime).toContainText("runtimeId", { timeout: 45_000 });
    }
    await expect(launched.page.getByTestId("host-status").first()).toContainText(
      /Agent Host ready|Agent settled|就绪/u,
      { timeout: 45_000 },
    );
    const trust = launched.page.getByTestId("project-trust-dialog-trust");
    if (await trust.isVisible().catch(() => false)) {
      await assertLiveTargets(
        "before-trust-click",
        launched,
        fixture,
        fixtureIdentity!,
        appPid,
        appHwnd,
        appTitle,
      );
      await trust.click();
    }
    hostBefore = await readHostIdentity(launched);

    stage = "action-dispatch";
    await assertLiveTargets(
      "before-prompt-fill",
      launched,
      fixture,
      fixtureIdentity!,
      appPid,
      appHwnd,
      appTitle,
    );
    await launched.page
      .getByTestId("prompt-input")
      .fill(`Click the one button in the isolated fixture exactly once. Test marker: ${marker}.`);
    await assertLiveTargets(
      "before-prompt-send",
      launched,
      fixture,
      fixtureIdentity!,
      appPid,
      appHwnd,
      appTitle,
    );
    await launched.page.getByTestId("send-prompt").click();
    stage = "wait-for-durable-dispatch";
    await expect
      .poll(
        async () => (await proxyEvents(proxyLog)).some((e) => e.kind === "fixture-action-started"),
        { timeout: 90_000 },
      )
      .toBe(true);
    await expect
      .poll(
        async () => {
          const rows = await listRecovery(launched!.page);
          const row = rows.length === 1 ? rows[0] : undefined;
          if (
            !row ||
            row.status !== "dispatching" ||
            row.pid !== fixture!.pid ||
            row.backend !== "munim" ||
            row.kind !== "click"
          )
            return false;
          const persisted = await readDurableAction(launched!, row.actionId).catch(() => undefined);
          if (
            !persisted ||
            persisted.status !== "dispatching" ||
            persisted.pid !== fixture!.pid ||
            persisted.backend !== "munim" ||
            persisted.kind !== "click"
          )
            return false;
          durableDispatching = persisted;
          return true;
        },
        { timeout: 15_000, intervals: [50, 100, 200] },
      )
      .toBe(true);
    assertDisplay2();
    await assertLiveTargets(
      "before-controlled-munim-kill",
      launched,
      fixture,
      fixtureIdentity!,
      appPid,
      appHwnd,
      appTitle,
    );
    if (fixture.exitCode !== null || fixture.signalCode !== null)
      throw new Error("Synthetic fixture process exited before controlled failure");
    const permitTemp = killPermit + ".tmp";
    await writeFile(
      permitTemp,
      JSON.stringify({
        actionId: durableDispatching!.actionId,
        status: durableDispatching!.status,
      }),
    );
    stage = "controlled-backend-termination";
    await rename(permitTemp, killPermit);
    await expect
      .poll(
        async () => {
          const currentEvents = await proxyEvents(proxyLog);
          const click = currentEvents.find((e) => e.kind === "click-forwarded-to-real-munim");
          return currentEvents.some(
            (e) =>
              e.kind === "real-munim-child-exited-after-controlled-kill" &&
              e.requestId === click?.requestId &&
              !!click &&
              eventsShareProcessChain(e, click),
          );
        },
        { timeout: 10_000 },
      )
      .toBe(true);
    const eventsAtFailure = await proxyEvents(proxyLog);
    const clickForwarded = eventsAtFailure.find((e) => e.kind === "click-forwarded-to-real-munim");
    const backendStarted = eventsAtFailure.find(
      (e) =>
        e.kind === "real-munim-child-started" &&
        !!clickForwarded &&
        eventsShareProcessChain(e, clickForwarded),
    );
    const actionStarted = eventsAtFailure.find(
      (e) =>
        e.kind === "fixture-action-started" &&
        e.requestId === clickForwarded?.requestId &&
        !!clickForwarded &&
        eventsShareProcessChain(e, clickForwarded),
    );
    const childExited = eventsAtFailure.find(
      (e) =>
        e.kind === "real-munim-child-exited-after-controlled-kill" &&
        e.requestId === clickForwarded?.requestId &&
        !!clickForwarded &&
        eventsShareProcessChain(e, clickForwarded),
    );
    expect(backendStarted?.childPid).toBeGreaterThan(0);
    expect(backendStarted?.realMunimPath?.toLowerCase()).toBe(realMunim!.toLowerCase());
    expect(clickForwarded?.childPid).toBe(backendStarted?.childPid);
    expect(actionStarted?.requestId).toBe(clickForwarded?.requestId);
    expect(eventsAtFailure.filter((e) => e.kind === "live-fixture-preflight-passed")).toHaveLength(
      3,
    );
    expect(
      eventsAtFailure.some((e) => e.kind === "live-fixture-preflight-passed-before-kill"),
    ).toBe(true);
    expect(eventsAtFailure.some((e) => e.kind === "click-result-before-controlled-kill")).toBe(
      false,
    );
    expect(
      eventsAtFailure.some((e) => e.kind === "early-click-result-makes-test-inconclusive"),
    ).toBe(false);
    expect(
      eventsAtFailure.some(
        (e) => e.kind === "kill-permit-received" && e.requestId === actionStarted?.requestId,
      ),
    ).toBe(true);
    const clickChainEvents = eventsAtFailure.filter(
      (e) => !!clickForwarded && eventsShareProcessChain(e, clickForwarded),
    );
    const order = (kind: string) => clickChainEvents.findIndex((e) => e.kind === kind);
    expect(order("click-forwarded-to-real-munim")).toBeLessThan(order("fixture-action-started"));
    expect(order("fixture-action-started")).toBeLessThan(
      order("live-fixture-preflight-passed-before-kill"),
    );
    expect(order("live-fixture-preflight-passed-before-kill")).toBeLessThan(
      order("kill-permit-received"),
    );
    expect(order("kill-permit-received")).toBeLessThan(
      order("real-munim-child-exited-after-controlled-kill"),
    );
    expect(childExited?.childPid).toBe(backendStarted?.childPid);
    expect((await readFile(startSentinel, "utf8")).trim().split(/\r?\n/u)).toHaveLength(1);
    expect(await readFile(endSentinel, "utf8").catch(() => "")).toBe("");
    expect(eventsAtFailure.some((e) => e.kind === "click-ended-before-controlled-failure")).toBe(
      false,
    );

    const afterAction = await launched.app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const handle = window?.getNativeWindowHandle();
      return window && handle?.length
        ? { hwnd: Number(handle.readBigUInt64LE()), bounds: window.getBounds() }
        : undefined;
    });
    expect(appPid).toBeGreaterThan(0);
    expect(appHwnd).toBeGreaterThan(0);
    expect(afterAction?.hwnd).toBe(appHwnd);
    expect(JSON.stringify(afterAction?.bounds)).toBe(JSON.stringify(appBoundsBefore));
    expect(insideDisplay2(appBoundsBefore)).toBe(true);
    expect(
      insideDisplay2({
        x: fixtureIdentity!.x,
        y: fixtureIdentity!.y,
        width: fixtureIdentity!.width,
        height: fixtureIdentity!.height,
      }),
    ).toBe(true);

    await expect
      .poll(async () => (await listRecovery(launched!.page)).length, { timeout: 30_000 })
      .toBe(1);
    const pending = await listRecovery(launched.page);
    expect(pending[0]).toMatchObject({
      backend: "munim",
      pid: fixture.pid,
      kind: "click",
      status: "unknown",
    });
    const durable = await readDurableAction(launched, pending[0]!.actionId);
    expect(durable).toMatchObject({
      status: "unknown",
      backend: "munim",
      pid: fixture.pid,
      kind: "click",
    });
    expect(gateway.nextWrapperBlockedBeforeProxy).toBe(true);
    expect(gateway.nextWrapperBlockReason).toBe("stale-token");
    expect(gateway.fixtureListSawOnlyFixturePid).toBe(true);
    expect(gateway.noForeignWindowTextReachedModel).toBe(true);
    expect(gateway.onlyFixturePidReachedModel).toBe(true);
    expect(gateway.externalRequestCount).toBe(0);
    await waitSettled(launched.page);
    expect(gateway.errors).toEqual([]);

    // The click's side effect remains independently live after backend loss. Let the fixture
    // finish naturally; the durable action must remain unknown and no second click is dispatched.
    await expect
      .poll(
        () =>
          readFile(endSentinel, "utf8")
            .then((s) => s.trim().split(/\r?\n/u).length)
            .catch(() => 0),
        { timeout: 55_000 },
      )
      .toBe(1);
    expect((await readFile(startSentinel, "utf8")).trim().split(/\r?\n/u)).toHaveLength(1);
    const finalProxyEvents = await proxyEvents(proxyLog);
    expect(finalProxyEvents.filter((e) => e.kind === "click-forwarded-to-real-munim")).toHaveLength(
      1,
    );
    expect(finalProxyEvents.filter((e) => e.kind === "click-request-accepted")).toHaveLength(1);
    expect(finalProxyEvents.some((e) => e.kind === "request-blocked-after-real-munim-exit")).toBe(
      false,
    );
    expect((await listRecovery(launched.page))[0]).toMatchObject({
      actionId: pending[0]!.actionId,
      status: "unknown",
    });
    const hostAfter = await readHostIdentity(launched);
    expect(hostAfter).toEqual(hostBefore);
    expect(await launched.app.evaluate(() => process.pid)).toBe(appPid);
    expect(await launched.page.getByTestId("host-status").first().textContent()).not.toMatch(
      /exited with code|Agent Host crashed/iu,
    );

    stage = "success-evidence";
    await writeFile(
      test.info().outputPath("munim-backend-failure-evidence.json"),
      JSON.stringify(
        {
          configuredBackend: "test-only stdio proxy; production Munim allowlist unchanged",
          delegatedBackend:
            "real Munim executable verified by direct-child process path and handle",
          realMunimPath: realMunim,
          modelGateway: "127.0.0.1 scripted, no external model request",
          isolatedUserData: userData,
          fixture: { pid: fixtureIdentity.pid, hwnd: fixtureIdentity.hwnd, bounds: fixtureBounds },
          packagedApp: { pid: appPid, hwnd: appHwnd, bounds: appBounds },
          agentHost: {
            before: hostBefore,
            after: hostAfter,
            sameProcess: JSON.stringify(hostBefore) === JSON.stringify(hostAfter),
          },
          proxyEvents: eventsAtFailure.map(
            ({ kind, requestId, childPid, proxyPid, reasonCode }) => ({
              kind,
              requestId,
              childPid,
              proxyPid,
              ...(isKnownSanitizerReasonCode(reasonCode) ? { reasonCode } : {}),
            }),
          ),
          persistedAction: durable,
          actionWasDurablyDispatchingBeforeKill: durableDispatching,
          repeatAction:
            "fresh wrapper probe rejected before proxy dispatch because the completed wrapper invalidated its previous snapshot token",
          durableRecoveryGate:
            "not claimed by this E2E; pending-action rejection requires its harness/store test evidence",
          sideEffect:
            "started before backend termination and completed later; completion does not resolve the recorded unknown result",
          rawWindowOrStderrContentLogged: false,
          onlyFixturePidReachedModel: gateway.onlyFixturePidReachedModel,
          externalGatewayRequests: gateway.externalRequestCount,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    failureObserved = true;
    keepProfile = true;
    test.info().annotations.push({
      type: "failure-evidence",
      description: `Sanitized failure evidence retained at ${join(root, "attempt-failure-cleanup.json")}; stage=${stage}.`,
    });
    throw error;
  } finally {
    try {
      if (launched) cleanupOk = (await bounded(() => launched!.app.close())) && cleanupOk;
    } catch {
      cleanupOk = false;
      keepProfile = true;
    }
    try {
      if (launched && cleanupOk) {
        let knownProxyStart = false;
        try {
          knownProxyStart = (await proxyEvents(proxyLog)).some(
            (event) => event.kind === "proxy-started" && Number.isInteger(event.proxyPid),
          );
        } catch {
          cleanupOk = false;
          keepProfile = true;
        }
        if (knownProxyStart && ownedProcessBaseline)
          cleanupOk =
            (await waitForOwnedProcessCleanup(
              proxyLog,
              proxyExe,
              realMunim!,
              ownedProcessBaseline,
              5_000,
            )) && cleanupOk;
        else if (hostMayHaveStarted) {
          // Host was known active, but absence of a proxy-started event cannot prove no child
          // was launched; retain the profile and surface cleanup as uncertain.
          cleanupOk = false;
          keepProfile = true;
        }
      }
    } catch {
      cleanupOk = false;
      keepProfile = true;
    }
    try {
      if (gateway) cleanupOk = (await bounded(() => gateway!.close())) && cleanupOk;
    } catch {
      cleanupOk = false;
      keepProfile = true;
    }
    if (fixture && isChildAlive(fixture)) {
      try {
        fixture.kill();
      } catch {
        cleanupOk = false;
        keepProfile = true;
      }
      if (!(await waitForChildExit(fixture, 2_000))) {
        cleanupOk = false;
        keepProfile = true;
      }
    }
    const childExit = fixture
      ? { code: fixture.exitCode, signal: fixture.signalCode, alive: isChildAlive(fixture) }
      : { code: null, signal: null, alive: false };
    const attemptEvidence = {
      schema: "prsloy.munim-backend-failure.attempt/v1",
      outcome: failureObserved || !cleanupOk ? "failed" : "completed",
      stage,
      fixturePid: fixture?.pid ?? null,
      fixtureProcess: childExit,
      proxyEvents: (await proxyEvents(proxyLog).catch(() => []))
        .filter((event) =>
          [
            "proxy-started",
            "real-munim-child-started",
            "real-munim-child-exited-after-controlled-kill",
            "proxy-start-failed",
            "real-munim-image-check-failed",
            "startup-child-cleanup-failed",
            "tool-result-sanitized",
            "tool-result-rejected",
            "proxy-exit",
          ].includes(event.kind ?? ""),
        )
        .map((event) => ({
          kind: event.kind,
          proxyPid: event.proxyPid,
          proxyCreationUtcTicks: event.proxyCreationUtcTicks,
          proxyImagePath: event.proxyImagePath,
          childPid: event.childPid,
          childCreationUtcTicks: event.childCreationUtcTicks,
          childImagePath: event.childImagePath,
          realMunimPath: event.realMunimPath,
          ...(isKnownSanitizerReasonCode(event.reasonCode) ? { reasonCode: event.reasonCode } : {}),
        })),
      cleanupOk,
      rawWindowOrStderrContentLogged: false,
      rawErrorOrConfigLogged: false,
    };
    try {
      await writeFile(
        join(root, "attempt-failure-cleanup.json"),
        JSON.stringify(attemptEvidence, null, 2),
      );
    } catch {
      cleanupOk = false;
      keepProfile = true;
    }
    if (
      cleanupOk &&
      !keepProfile &&
      (!fixture || fixture.exitCode !== null || fixture.signalCode !== null)
    ) {
      try {
        await rm(root, { recursive: true, force: true });
      } catch {
        cleanupOk = false;
        keepProfile = true;
        try {
          await writeFile(
            join(root, "attempt-failure-cleanup.json"),
            JSON.stringify({ ...attemptEvidence, outcome: "failed", cleanupOk: false }, null, 2),
          );
        } catch {
          // Keep the test failed; the original sanitized evidence remains if the rewrite fails.
        }
        test.info().annotations.push({
          type: "cleanup",
          description: "Temporary test-root removal failed; retained remaining profile files.",
        });
      }
    } else {
      test.info().annotations.push({
        type: "cleanup",
        description: `Isolated profile retained at ${root}; bounded cleanup or evidence failed (cleanupOk=${cleanupOk}).`,
      });
    }
  }
  expect(cleanupOk, "bounded cleanup failed; isolated profile retained").toBe(true);
});

type ProxyEvent = {
  kind?: string;
  reasonCode?: string;
  requestId?: number;
  childPid?: number;
  proxyPid?: number;
  proxyCreationUtcTicks?: string;
  proxyImagePath?: string;
  childCreationUtcTicks?: string;
  childImagePath?: string;
  realMunimPath?: string;
};
function isKnownSanitizerReasonCode(value?: string): value is string {
  return /^(?:response_not_object|result_missing|result_not_object|backend_tool_error|backend_error_flag_invalid|content_not_array|text_part_count|fixture_pid_row_count|fixture_window_count|list_apps_sanitized|state_pid_header_mismatch|state_status_missing|state_status_multiple_rows|state_status_shape_invalid|state_action_line_count|state_action_tokenized_backend_id_unsupported|get_app_state_sanitized|unsupported_tool|real_munim_start_exception|real_munim_start_returned_false|image_read_failed|image_path_mismatch|bounded_exit_timeout|owned_handle_kill_failed|real_munim_image_read_failed|real_munim_image_path_mismatch)$/u.test(
    value ?? "",
  );
}
async function proxyEvents(path: string): Promise<ProxyEvent[]> {
  return (await readFile(path, "utf8").catch(() => ""))
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((l) => JSON.parse(l) as ProxyEvent);
}
async function waitForOwnedProcessCleanup(
  path: string,
  expectedImagePath: string,
  expectedMunimPath: string,
  baseline: OwnedProcessIdentity[],
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = await proxyEvents(path);
    try {
      const current = queryOwnedProcessIdentities([expectedImagePath, expectedMunimPath]);
      if (
        proxyLifecycleIsVerified(events, expectedImagePath, expectedMunimPath) &&
        noNewOwnedProcessesRemain(baseline, current, [expectedImagePath, expectedMunimPath], true)
      )
        return true;
    } catch {
      // An unavailable or incomplete process inventory is not evidence of cleanup.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function queryOwnedProcessIdentities(expectedImages: string[]): OwnedProcessIdentity[] {
  if (expectedImages.length === 0 || expectedImages.some((path) => !isAbsoluteFile(path)))
    throw new Error("Owned-process query requires absolute executable paths");
  const payload = Buffer.from(JSON.stringify({ paths: expectedImages }), "utf16le").toString(
    "base64",
  );
  const script = [
    "$ErrorActionPreference='Stop'",
    "try {",
    `  $inputData = [System.Text.Encoding]::Unicode.GetString([System.Convert]::FromBase64String('${payload}')) | ConvertFrom-Json -ErrorAction Stop`,
    "  $paths = @($inputData.paths | ForEach-Object { [System.IO.Path]::GetFullPath([string]$_) })",
    "  $names = @($paths | ForEach-Object { [System.IO.Path]::GetFileName($_) } | Select-Object -Unique)",
    "  $items = @()",
    "  $processes = @(Get-Process -ErrorAction Stop | Where-Object { $names -contains ($_.ProcessName + '.exe') })",
    "  foreach ($process in $processes) {",
    "    if ([string]::IsNullOrWhiteSpace([string]$process.Path)) { throw 'matching_process_image_unavailable' }",
    "    $image = [System.IO.Path]::GetFullPath([string]$process.Path)",
    "    if ($paths -contains $image) {",
    "      if ($null -eq $process.Id -or $null -eq $process.StartTime) { throw 'matching_process_identity_incomplete' }",
    "      $created = $process.StartTime.ToUniversalTime()",
    "      $items += [pscustomobject]@{ pid=[int]$process.Id; creationUtcTicks=[string]$created.Ticks; imagePath=$image }",
    "    }",
    "  }",
    "  [Console]::Out.WriteLine((ConvertTo-Json -InputObject @($items) -Compress -ErrorAction Stop))",
    "  exit 0",
    "} catch { [Console]::Error.WriteLine('owned_process_inventory_failed'); exit 31 }",
  ].join("; ");
  const encodedScript = Buffer.from(script, "utf16le").toString("base64");
  const output = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedScript],
    { encoding: "utf8", windowsHide: true, timeout: 8_000, stdio: ["ignore", "pipe", "ignore"] },
  ).trim();
  const decoded: unknown = JSON.parse(output);
  if (!Array.isArray(decoded)) throw new Error("Owned-process inventory was not an array");
  const allowed = new Set(expectedImages.map((path) => path.toLowerCase()));
  return decoded.map((item): OwnedProcessIdentity => {
    if (typeof item !== "object" || item === null) throw new Error("Invalid process identity");
    const row = item as Record<string, unknown>;
    if (
      !Number.isSafeInteger(row.pid) ||
      (row.pid as number) <= 0 ||
      typeof row.creationUtcTicks !== "string" ||
      !/^[0-9]{1,19}$/u.test(row.creationUtcTicks) ||
      BigInt(row.creationUtcTicks) <= 0n ||
      typeof row.imagePath !== "string" ||
      !allowed.has(row.imagePath.toLowerCase())
    )
      throw new Error("Incomplete or unexpected process identity");
    return {
      pid: row.pid as number,
      creationUtcTicks: row.creationUtcTicks,
      imagePath: row.imagePath,
    };
  });
}
function publish(project: string, output: string, isolated: string): void {
  execFileSync(
    "dotnet",
    [
      "publish",
      project,
      "-c",
      "Release",
      "-o",
      output,
      "--nologo",
      `-p:BaseOutputPath=${join(isolated, "bin")}${sep}`,
      `-p:BaseIntermediateOutputPath=${join(isolated, "obj")}${sep}`,
      `-p:MSBuildProjectExtensionsPath=${join(isolated, "obj")}${sep}`,
    ],
    { stdio: "pipe", windowsHide: true, timeout: 60_000 },
  );
}
function isAbsoluteFile(path: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(path) || path.startsWith("\\\\");
}
async function waitForFixtureIdentity(path: string, expectedPid: number): Promise<FixtureIdentity> {
  for (let i = 0; i < 80; i++) {
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as FixtureIdentity;
      if (value.pid === expectedPid && value.hwnd > 0) return value;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Fixture did not publish its own HWND identity in time");
}
function assertFixtureIdentity(identity: FixtureIdentity, _title: string): void {
  if (
    identity.x !== fixtureBounds.x ||
    identity.y !== fixtureBounds.y ||
    identity.width !== fixtureBounds.width ||
    identity.height !== fixtureBounds.height ||
    identity.pid <= 0 ||
    identity.hwnd <= 0
  )
    throw new Error("Fixture PID/HWND/bounds check failed");
}
function assertDisplay2(): void {
  const script = String.raw`Add-Type -AssemblyName System.Windows.Forms; $s=@([System.Windows.Forms.Screen]::AllScreens|Where-Object{$_.DeviceName -eq '\\.\DISPLAY2' -and -not $_.Primary}); if($s.Count -ne 1 -or $s[0].Bounds.X -ne 2560 -or $s[0].Bounds.Y -ne 0 -or $s[0].Bounds.Width -ne 1920 -or $s[0].Bounds.Height -ne 1080){exit 1}`;
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    stdio: "ignore",
    windowsHide: true,
    timeout: 10_000,
  });
}
function insideDisplay2(b: { x: number; y: number; width: number; height: number }): boolean {
  return b.x >= 2560 && b.y >= 0 && b.x + b.width <= 4480 && b.y + b.height <= 1032;
}
function nearBounds(
  actual: { x: number; y: number; width: number; height: number },
  expected: { x: number; y: number; width: number; height: number },
  tolerance = 12,
): boolean {
  return (
    Math.abs(actual.x - expected.x) <= tolerance &&
    Math.abs(actual.y - expected.y) <= tolerance &&
    Math.abs(actual.width - expected.width) <= tolerance &&
    Math.abs(actual.height - expected.height) <= tolerance
  );
}
function isChildAlive(child: ReturnType<typeof spawn>): boolean {
  return child.exitCode === null && child.signalCode === null;
}
async function waitForChildExit(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<boolean> {
  if (!isChildAlive(child)) return true;
  return await new Promise<boolean>((resolve) => {
    const finish = (value: boolean) => {
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(!isChildAlive(child)), timeoutMs);
    child.once("exit", onExit);
    if (!isChildAlive(child)) finish(true);
  });
}
async function readElectronWindow(launched: Awaited<ReturnType<typeof launchZenoApp>>): Promise<{
  pid: number;
  hwnd: number;
  bounds: { x: number; y: number; width: number; height: number };
}> {
  const identity = await launched.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const handle = win?.getNativeWindowHandle();
    return win && handle?.length
      ? { pid: process.pid, hwnd: Number(handle.readBigUInt64LE()), bounds: win.getBounds() }
      : undefined;
  });
  if (!identity?.pid || !identity.hwnd)
    throw new Error("Packaged Electron window has no live main-process HWND");
  return identity;
}
async function assertLiveTargets(
  stage: string,
  launched: Awaited<ReturnType<typeof launchZenoApp>>,
  fixture: ReturnType<typeof spawn>,
  fixtureIdentity: FixtureIdentity,
  appPid: number,
  appHwnd: number,
  appTitle: string,
): Promise<void> {
  assertDisplay2();
  if (!isChildAlive(fixture)) throw new Error(`${stage}: owned fixture process exited`);
  const fixtureNative = readExactWindowInfo(fixtureIdentity.hwnd);
  if (
    fixtureNative.pid !== fixtureIdentity.pid ||
    fixtureNative.title !== "PRSLOY Backend Failure Fixture" ||
    !nearBounds(fixtureNative.bounds, {
      x: fixtureIdentity.x,
      y: fixtureIdentity.y,
      width: fixtureIdentity.width,
      height: fixtureIdentity.height,
    }) ||
    !insideDisplay2(fixtureNative.bounds)
  )
    throw new Error(`${stage}: live fixture HWND/PID/title/bounds no longer match DISPLAY2 target`);
  const electron = await readElectronWindow(launched);
  if (
    electron.pid !== appPid ||
    electron.hwnd !== appHwnd ||
    JSON.stringify(electron.bounds) !== JSON.stringify(appBounds)
  )
    throw new Error(`${stage}: Electron main PID/HWND/bounds changed`);
  const appNative = readExactWindowInfo(appHwnd);
  if (appNative.pid !== appPid || appNative.title !== appTitle || !insideDisplay2(appNative.bounds))
    throw new Error(
      `${stage}: live app HWND/PID/title/native bounds are outside DISPLAY2 or changed`,
    );
}
function readExactWindowInfo(hwnd: number): NativeWindowInfo {
  const source = `using System;using System.Runtime.InteropServices;using System.Text;public static class PrsloyMunimBackendFailureNativeProbe{[StructLayout(LayoutKind.Sequential)]public struct RECT{public int Left;public int Top;public int Right;public int Bottom;}[DllImport("user32.dll",SetLastError=true)]static extern bool IsWindow(IntPtr h);[DllImport("user32.dll",SetLastError=true)]static extern bool IsWindowVisible(IntPtr h);[DllImport("user32.dll",SetLastError=true)]static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);[DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetWindowText(IntPtr h,StringBuilder s,int n);[DllImport("user32.dll",SetLastError=true)]static extern bool GetWindowRect(IntPtr h,out RECT r);public static object Read(long raw){var h=new IntPtr(raw);if(!IsWindow(h)||!IsWindowVisible(h))throw new Exception("HWND missing or hidden");uint p;if(GetWindowThreadProcessId(h,out p)==0)throw new Exception("window PID unavailable");RECT r;if(!GetWindowRect(h,out r))throw new Exception("window bounds unavailable");var t=new StringBuilder(512);GetWindowText(h,t,t.Capacity);return new object[]{(int)p,t.ToString(),r.Left,r.Top,r.Right-r.Left,r.Bottom-r.Top};}}`;
  const output = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Add-Type -TypeDefinition @'\n${source}\n'@; [PrsloyMunimBackendFailureNativeProbe]::Read(${hwnd}) | ConvertTo-Json -Compress`,
    ],
    { encoding: "utf8", windowsHide: true, timeout: 5_000 },
  ).trim();
  const row = JSON.parse(output) as [number, string, number, number, number, number];
  if (
    row.length !== 6 ||
    typeof row[1] !== "string" ||
    !row.every((value, i) => i === 1 || Number.isFinite(value))
  )
    throw new Error("Live native HWND identity is malformed");
  return {
    pid: row[0]!,
    title: row[1]!,
    bounds: { x: row[2]!, y: row[3]!, width: row[4]!, height: row[5]! },
  };
}
async function listRecovery(page: import("playwright").Page): Promise<ActionRow[]> {
  return page.evaluate(() => window.zeno.prsloy.cuaRecovery.list()) as Promise<ActionRow[]>;
}
async function readDurableAction(
  launched: Awaited<ReturnType<typeof launchZenoApp>>,
  actionId: string,
): Promise<ActionRow | undefined> {
  return launched.app.evaluate(({ app }, id) => {
    const path = process.getBuiltinModule("node:path")!;
    const sqlite = process.getBuiltinModule("node:sqlite")!;
    const db = new sqlite.DatabaseSync(
      path.join(app.getPath("userData"), "prsloy", "cua-recovery.sqlite"),
      { readOnly: true },
    );
    try {
      return db
        .prepare(
          "SELECT action_id as actionId,status,backend,pid,kind FROM cua_actions WHERE action_id=? AND profile_id='default'",
        )
        .get(id) as ActionRow | undefined;
    } finally {
      db.close();
    }
  }, actionId) as Promise<ActionRow | undefined>;
}
async function readHostIdentity(
  launched: Awaited<ReturnType<typeof launchZenoApp>>,
): Promise<{ pid: number; creationTime: number }> {
  const hosts = await launched.app.evaluate(({ app }) =>
    app
      .getAppMetrics()
      .filter((m) => m.name === "PRSLOY Agent Host")
      .map(({ pid, creationTime }) => ({ pid, creationTime })),
  );
  if (hosts.length !== 1 || !hosts[0]?.pid || !Number.isFinite(hosts[0].creationTime))
    throw new Error("Expected one live Agent Host process");
  return hosts[0] as { pid: number; creationTime: number };
}
async function bounded(task: () => Promise<unknown>, ms = 8_000): Promise<boolean> {
  return await Promise.race([
    task().then(
      () => true,
      () => false,
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);
}

type LocalFailureGateway = {
  baseUrl: string;
  nextWrapperBlockedBeforeProxy: boolean;
  nextWrapperBlockReason?: string;
  fixtureListSawOnlyFixturePid: boolean;
  noForeignWindowTextReachedModel: boolean;
  onlyFixturePidReachedModel: boolean;
  externalRequestCount: number;
  errors: string[];
  close(): Promise<void>;
};
async function startLocalFailureGateway(
  fixturePid: number,
  marker: string,
): Promise<LocalFailureGateway> {
  const result: LocalFailureGateway = {
    baseUrl: "",
    nextWrapperBlockedBeforeProxy: false,
    fixtureListSawOnlyFixturePid: false,
    noForeignWindowTextReachedModel: true,
    onlyFixturePidReachedModel: true,
    externalRequestCount: 0,
    errors: [],
    close: async () => undefined,
  };
  let clickAttempts = 0;
  let cachedToken = "";
  const server: Server = createServer((req, res) => {
    void (async () => {
      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "local-scripted" }] }));
        return;
      }
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404).end();
        return;
      }
      let raw = "";
      for await (const chunk of req) raw += String(chunk);
      const body = JSON.parse(raw) as {
        messages?: ModelMessage[];
        tools?: Array<{ function?: { name?: string } }>;
      };
      const messages = body.messages ?? [];
      const latestUser = normalizeUserTextContent(
        messages.filter((m) => m.role === "user").at(-1)?.content,
      );
      const toolResult = messages.filter((m) => m.role === "tool").at(-1)?.content;
      const resultText =
        typeof toolResult === "string"
          ? toolResult
          : Array.isArray(toolResult)
            ? (toolResult as Array<{ text?: string }>).map((p) => p.text ?? "").join("\n")
            : "";
      const previous = [...messages].reverse().find((m) => m.role === "assistant" && m.tool_calls)
        ?.tool_calls?.[0]?.function?.name;
      result.noForeignWindowTextReachedModel &&=
        !/Other private app|password manager|mail inbox/iu.test(raw);
      const pids = [...raw.matchAll(/\bpid\s*[=:]?\s*(\d+)/giu)].map((m) => Number(m[1]));
      result.onlyFixturePidReachedModel &&= pids.every((pid) => pid === fixturePid);
      if (previous === "munim_list_apps") {
        result.fixtureListSawOnlyFixturePid =
          resultText === `PRSLOY Backend Failure Fixture [fixture] pid=${fixturePid} windows=1`;
        await modelResponse(res, "munim_get_app_state", { pid: fixturePid }, messages.length);
        return;
      }
      if (previous === "munim_get_app_state") {
        const token = parseFixtureButtonToken(resultText, "Start isolated test action");
        if (!token || !resultText.includes("Start isolated test action"))
          throw new Error("Filtered fixture state did not contain the expected control");
        cachedToken = token;
        clickAttempts += 1;
        await modelResponse(
          res,
          "munim_click",
          { pid: fixturePid, element_token: token },
          messages.length,
        );
        return;
      }
      if (previous === "munim_click") {
        if (/CUA_RECOVERY_BLOCKED/u.test(resultText)) {
          result.nextWrapperBlockedBeforeProxy = true;
          result.nextWrapperBlockReason = "durable-recovery-gate";
          await modelText(res, "Recovery gate blocked the next action.", messages.length);
          return;
        }
        if (clickAttempts === 1) {
          clickAttempts += 1;
          await modelResponse(
            res,
            "munim_click",
            { pid: fixturePid, element_token: cachedToken },
            messages.length,
          );
          return;
        }
        if (/Токен устарел|token.*stale/iu.test(resultText)) {
          result.nextWrapperBlockedBeforeProxy = true;
          result.nextWrapperBlockReason = "stale-token";
          await modelText(
            res,
            "The next wrapper action was blocked before backend dispatch.",
            messages.length,
          );
          return;
        }
        await modelText(res, "Backend outcome remains unknown; no retry.", messages.length);
        return;
      }
      if (latestUser?.includes(marker)) {
        await modelResponse(res, "munim_list_apps", {}, messages.length);
        return;
      }
      await modelText(res, "No action.", messages.length);
    })().catch(async () => {
      result.errors.push("scripted-handler-error");
      if (!res.headersSent) {
        try {
          await modelText(
            res,
            "The local scripted gateway stopped safely without another tool call.",
            0,
          );
        } catch {
          if (!res.writableEnded) res.end("data: [DONE]\n\n");
        }
      } else if (!res.writableEnded) res.end("data: [DONE]\n\n");
    });
  });
  server.on("connection", (socket) => {
    if (!(socket.remoteAddress === "127.0.0.1" || socket.remoteAddress === "::ffff:127.0.0.1"))
      result.externalRequestCount++;
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Could not bind local scripted gateway");
  result.baseUrl = `http://127.0.0.1:${address.port}/v1`;
  result.close = async () => {
    server.closeAllConnections();
    server.close();
    await new Promise<void>((resolve) => server.once("close", resolve));
  };
  return result;
}
async function modelResponse(
  res: ServerResponse,
  name: string,
  args: Record<string, unknown>,
  step: number,
): Promise<void> {
  const id = `backend-failure-${step}-${randomUUID()}`;
  return stream(res, {
    role: "assistant",
    content: null,
    tool_calls: [
      { index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } },
    ],
  });
}
async function modelText(res: ServerResponse, content: string, _step: number): Promise<void> {
  return stream(res, { role: "assistant", content });
}
async function stream(res: ServerResponse, delta: Record<string, unknown>): Promise<void> {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const id = `local-${randomUUID()}`;
  res.write(
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "local-scripted", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
  );
  res.write(
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "local-scripted", choices: [{ index: 0, delta: {}, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }] })}\n\n`,
  );
  res.end("data: [DONE]\n\n");
}
