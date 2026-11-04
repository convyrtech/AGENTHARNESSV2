import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { createServer, type Server } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, launchZenoApp, test, waitSettled } from "./fixtures.ts";

const packaged = process.env.PRSLOY_E2E_PACKAGED?.trim();
const cuaBinary = process.env.PRSLOY_CUA_BINARY?.trim();
const project = fileURLToPath(new URL("./cua-fixture/CuaFixture.csproj", import.meta.url));
const marker = "PRSLOY-CUA-PACKAGED-E2E";
const fixtureTitle = "PRSLOY 104 Packaged Cua Fixture";
const secondFixtureTitle = `${fixtureTitle} Secondary`;
const appBounds = { x: 2580, y: 500, width: 1000, height: 500 };
const fixtureBounds = { x: 2640, y: 80, width: 560, height: 340 };
const secondaryFixtureBounds = { x: 3240, y: 80, width: 420, height: 180 };

type Message = { role?: string; content?: unknown; tool_calls?: unknown };
type RawTool = {
  type?: string;
  function?: { name?: string; parameters?: Record<string, unknown> };
};
type WindowRow = {
  pid: number;
  window_id: number;
  title: string;
  bounds?: { x: number; y: number; width: number; height: number };
};
type Snapshot = { snapshot_id?: string; elements?: Record<string, unknown>[]; markdown?: string };
type WindowBounds = { x: number; y: number; width: number; height: number };
type InternalGateway = ScriptedGateway & {
  fixtureWindow?: WindowRow;
  secondaryWindow?: WindowRow;
  firstSnapshot?: Snapshot;
  secondSnapshot?: Snapshot;
  thirdSnapshot?: Snapshot;
  afterTypeSnapshot?: Snapshot;
  delayWrapperNames: string[];
  delayClickCount: number;
  delayClickRequested: boolean;
  delayModelRequestCount: number;
  delayFollowupPending: boolean;
  delayFollowupAborted: boolean;
  delayFollowupTimedOut: boolean;
  delayModelRequestCountAtStop: number;
  delayFollowupPendingAtStop: boolean;
  appPid: number;
  appHwnd: number;
  listWindowDiagnostics: unknown;
  windowBounds?: { app: WindowBounds; fixture: WindowBounds; secondaryFixture: WindowBounds };
  stopClickedAfterStartMarker: boolean;
  delayedResultAfterStop: string;
  delayedResultAtStop: string;
  fixtureEffectStartedAtUtc: string;
  stopRequestedAtUtc: string;
  activeCuaClickCountAtStop: number;
  optOutReplyObserved: boolean;
  gatewayStepEvidence: Record<string, unknown>[];
  gatewayErrors: string[];
  gatewayResponseStatuses: number[];
  typePendingReleased: boolean;
  typeResultSeen: boolean;
  savePendingReleased: boolean;
  crashRetryMode: boolean;
  blockedAfterCrash: boolean;
  crashActionId: string;
  invalidChallengeRejected: boolean;
  stopClickCount: number;
  stopModelRequestCount: number;
  stopStartMarker: string;
};

test("packaged CUA uses exact HWND, fresh tokens, narrow top-level wrappers, images, and opt-out", async () => {
  test.skip(!packaged, "requires PRSLOY_E2E_PACKAGED to point to the Windows packaged executable");
  test.skip(process.platform !== "win32", "the live CUA driver requires Windows UI Automation");
  test.skip(!cuaBinary, "set PRSLOY_CUA_BINARY to the verified portable Cua driver");
  test.setTimeout(240_000);

  const root = await mkdtemp(join(tmpdir(), "prsloy-cua-packaged-"));
  const build = join(tmpdir(), `prsloy-cua-fixture-${process.pid}-${Date.now()}`);
  const fixtureOutput = join(root, "fixture-result.txt");
  const published = join(build, "publish");
  const obj = join(build, "obj");
  const bin = join(build, "bin");
  let fixture: ReturnType<typeof spawn> | undefined;
  let launched: Awaited<ReturnType<typeof launchZenoApp>> | undefined;
  let gateway: InternalGateway | undefined;
  const evidencePath = test.info().outputPath("cua-packaged-evidence.json");
  try {
    expect([appBounds, fixtureBounds, secondaryFixtureBounds].every(insideDisplay2)).toBe(true);
    await mkdir(join(root, "electron-userData"), { recursive: true });
    const userAgentDir = join(root, "home", ".pi", "agent");
    await mkdir(userAgentDir, { recursive: true });
    await writeFile(
      join(userAgentDir, "settings.json"),
      JSON.stringify({ extensions: ["+builtin:mcp"] }),
    );
    // The app and both fixture HWNDs are positioned inside DISPLAY2 before either launches.
    await writeFile(
      join(root, "electron-userData", "zeno-desktop.json"),
      JSON.stringify({
        recentWorkspaces: [],
        window: appBounds,
      }),
    );
    execFileSync(
      "dotnet",
      [
        "publish",
        project,
        "-c",
        "Release",
        "-o",
        published,
        `-p:BaseOutputPath=${bin}${sep}`,
        `-p:BaseIntermediateOutputPath=${obj}${sep}`,
        `-p:MSBuildProjectExtensionsPath=${obj}${sep}`,
      ],
      { stdio: "pipe" },
    );
    const fixtureDll = join(published, "PrsloyCuaFixture.dll");
    fixture = spawn(
      "dotnet",
      [fixtureDll, fixtureOutput, String(fixtureBounds.x), String(fixtureBounds.y), "--two"],
      { stdio: "ignore" },
    );
    await waitForFixtureProcess(fixture.pid);
    gateway = await startCuaGateway(fixture.pid ?? 0, fixtureOutput, marker);

    launched = await launchZenoApp({
      root,
      tools: "read,cua_list_apps,cua_list_windows,cua_get_window_state,cua_click,cua_type_text",
      modelBaseUrl: gateway.baseUrl,
      modelApiKey: "packaged-cua-test-only",
      modelInput: ["text", "image"],
      env: { PRSLOY_COMPUTER_USE: "1", PRSLOY_CUA_BINARY: cuaBinary! },
    });
    // Test the packaged Electron main process itself, not the developer's Node.
    const sqliteAvailable = await launched.app.evaluate(() => {
      const sqlite = process.getBuiltinModule("node:sqlite") as
        | typeof import("node:sqlite")
        | undefined;
      if (!sqlite) return false;
      const db = new sqlite.DatabaseSync(":memory:");
      try {
        db.exec("CREATE TABLE probe (n INTEGER); INSERT INTO probe VALUES (104)");
        return (db.prepare("SELECT n FROM probe").get() as { n: number }).n === 104;
      } finally {
        db.close();
      }
    });
    expect(sqliteAvailable).toBe(true);
    const appHwndHex = await launched.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.getNativeWindowHandle().toString("hex"),
    );
    if (!appHwndHex) throw new Error("Packaged PRSLOY native HWND was unavailable");
    gateway.appHwnd = Number(Buffer.from(appHwndHex, "hex").readBigUInt64LE());
    const appWindowInfo = readExactWindowInfo(gateway.appHwnd);
    gateway.appPid = appWindowInfo.pid;
    await launched.fakeModel.stop();
    const mainRequestsBefore = gateway.modelRequestCount;
    await startHostAndTrust(launched.page, "Run the packaged CUA fixture flow.");
    await expect.poll(() => gateway!.modelRequestCount).toBeGreaterThan(mainRequestsBefore);
    await expect.poll(() => gateway!.typeResultSeen, { timeout: 45_000 }).toBe(true);
    expect(await launched.page.evaluate(() => window.zeno.prsloy.cuaRecovery.list())).toEqual([]);
    gateway.typePendingReleased = true;
    await expect.poll(() => readFile(fixtureOutput, "utf8").catch(() => "")).toBe(marker);
    await acknowledgeRecovery(launched.page, "cua-recovery-completed");
    gateway.savePendingReleased = true;
    await waitSettled(launched.page);
    expect(gateway.fixtureWindow, JSON.stringify(gateway.listWindowDiagnostics)).toBeDefined();
    if (!gateway.fixtureWindow) {
      console.info(
        "[cua-e2e] sanitized list_windows result",
        JSON.stringify(gateway.listWindowDiagnostics),
      );
    }

    const result = await readFile(fixtureOutput, "utf8");
    expect(result).toBe(marker);
    expect(gateway.wrapperNames).toEqual([
      "cua_list_windows",
      "cua_get_window_state",
      "cua_get_window_state",
      "cua_type_text",
      "cua_click",
      "cua_get_window_state",
      "cua_type_text",
      "cua_get_window_state",
      "cua_click",
      "cua_get_window_state",
    ]);
    expect(gateway.rawAttemptRejected).toBe(true);
    expect(gateway.topLevelRawToolsAdvertised).toBe(false);
    expect(gateway.strictWrapperSchemas).toBe(true);
    expect(gateway.staleTokenRejected).toBe(true);
    expect(gateway.windowMismatchRejected).toBe(true);
    expect(gateway.exactFixtureTargetUsed).toBe(true);
    expect(gateway.allTestWindowsOnDisplay2).toBe(true);
    expect(gateway.distinctSnapshots).toBe(true);
    expect(gateway.rejectedActionsLeftFixtureUntouched).toBe(true);
    expect(gateway.imageUrlSeen).toBe(true);
    expect(gateway.imageUrlCount).toBeGreaterThan(0);
    expect(gateway.readableSavedStateSeen).toBe(true);
    expect(gateway.directRawToolAttemptCount).toBe(1);
    expect(
      JSON.parse(await readFile(join(userAgentDir, "settings.json"), "utf8")).extensions,
    ).toContain("+builtin:mcp");

    // Stop only after the fixture's explicit start marker proves the side effect began.
    const delayStart = `${fixtureOutput}.start`;
    const delayResult = `${fixtureOutput}.delayed-result`;
    const delayRequestsBefore = gateway.modelRequestCount;
    await launched.page
      .getByTestId("prompt-input")
      .fill("Start the controlled delayed side effect once; do not repeat it.");
    await launched.page.getByTestId("send-prompt").click();
    await expect.poll(() => gateway!.modelRequestCount).toBeGreaterThan(delayRequestsBefore);
    await expect.poll(() => gateway!.delayClickRequested).toBe(true);
    await expect
      .poll(() =>
        readFile(delayStart, "utf8")
          .then((value) => value.trim().startsWith("started"))
          .catch(() => false),
      )
      .toBe(true);
    const startLines = (await readFile(delayStart, "utf8")).trim().split(/\r?\n/u);
    gateway.fixtureEffectStartedAtUtc = startLines[1] ?? "timestamp-missing";
    gateway.delayModelRequestCountAtStop = gateway.delayModelRequestCount;
    gateway.activeCuaClickCountAtStop = await launched.page
      .locator('[data-kind="tool"][data-status="running"]')
      .count();
    gateway.delayedResultAtStop = await readFile(delayResult, "utf8").catch(
      () => "not-yet-complete",
    );
    gateway.delayFollowupPendingAtStop = gateway.delayFollowupPending;
    expect(gateway.delayedResultAtStop).toBe("not-yet-complete");
    expect(gateway.delayFollowupPending).toBe(false);
    await expect(launched.page.getByTestId("abort-prompt")).toBeVisible({ timeout: 5_000 });
    gateway.stopRequestedAtUtc = new Date().toISOString();
    await launched.page.getByTestId("abort-prompt").click({ force: true });
    gateway.stopClickedAfterStartMarker = true;
    await expect(launched.page.getByTestId("host-status").first()).toContainText(
      /Agent aborted|Agent settled/,
      { timeout: 20_000 },
    );
    // Cua/Stop provides no backend cancellation marker. Record what the external fixture actually did.
    const delayedEffectCompleted = await expect
      .poll(
        () =>
          readFile(delayResult, "utf8")
            .then((value) => value === "completed")
            .catch(() => false),
        { timeout: 30_000 },
      )
      .toBe(true)
      .then(() => true)
      .catch(() => false);
    expect(startLines[0]).toBe("started");
    gateway.delayedResultAfterStop = delayedEffectCompleted
      ? await readFile(delayResult, "utf8")
      : "not-completed-within-30s";
    expect(gateway.delayClickCount).toBe(1);
    expect(gateway.delayModelRequestCount).toBeLessThanOrEqual(4);
    gateway.stopClickCount = gateway.delayClickCount;
    gateway.stopModelRequestCount = gateway.delayModelRequestCount;
    gateway.stopStartMarker = startLines.join("\n");
    expect(gateway.delayWrapperNames).toEqual([
      "cua_list_windows",
      "cua_get_window_state",
      "cua_click",
    ]);

    // Explicitly resolve the stopped action, then start a second one and kill its host.
    await acknowledgeRecovery(launched.page, "cua-recovery-completed");
    await rm(delayStart, { force: true });
    await rm(delayResult, { force: true });
    gateway.delayClickRequested = false;
    await launched.page
      .getByTestId("prompt-input")
      .fill("Start the controlled delayed side effect once; do not repeat it.");
    await launched.page.getByTestId("send-prompt").click();
    await expect.poll(() => gateway!.delayClickRequested).toBe(true);
    await expect
      .poll(() =>
        readFile(delayStart, "utf8")
          .then((v) => v.startsWith("started"))
          .catch(() => false),
      )
      .toBe(true);
    const beforeCrash = await launched.page.evaluate(() => window.zeno.prsloy.cuaRecovery.list());
    expect(beforeCrash).toHaveLength(1);
    const crashActionId = beforeCrash[0]!.actionId;
    gateway.crashActionId = crashActionId;
    // Packaged builds deliberately do not expose the test crash IPC. Select only this
    // Electron app's named utility process, then kill that exact child PID.
    const hostProcesses = await launched.app.evaluate(({ app }) =>
      app
        .getAppMetrics()
        .filter((metric) => metric.name === "PRSLOY Agent Host")
        .map(({ pid, creationTime }) => ({ pid, creationTime })),
    );
    expect(hostProcesses).toHaveLength(1);
    await launched.app.evaluate(({ app }, target) => {
      if (
        !app
          .getAppMetrics()
          .some(
            (metric) =>
              metric.name === "PRSLOY Agent Host" &&
              metric.pid === target.pid &&
              metric.creationTime === target.creationTime,
          )
      )
        throw new Error("Refusing to kill an unverified process");
      process.kill(target.pid);
    }, hostProcesses[0]!);
    await expect
      .poll(
        async () =>
          (await launched!.page.evaluate(() => window.zeno.prsloy.cuaRecovery.list()))[0]?.status,
      )
      .toBe("unknown");
    await expect
      .poll(
        () =>
          readFile(delayResult, "utf8")
            .then((v) => v === "completed")
            .catch(() => false),
        { timeout: 35_000 },
      )
      .toBe(true);
    await launched.app.close();
    await launched.fakeModel.stop();
    launched = await launchZenoApp({
      root,
      tools: "read,cua_list_apps,cua_list_windows,cua_get_window_state,cua_click,cua_type_text",
      modelBaseUrl: gateway.baseUrl,
      modelApiKey: "packaged-cua-test-only",
      modelInput: ["text", "image"],
      env: { PRSLOY_COMPUTER_USE: "1", PRSLOY_CUA_BINARY: cuaBinary!, ZENO_AUTO_EXTENSION_UI: "1" },
    });
    const afterRestart = await launched.page.evaluate(() => window.zeno.prsloy.cuaRecovery.list());
    expect(afterRestart).toMatchObject([{ actionId: crashActionId, status: "unknown" }]);
    const invalidChallengeRejected = await launched.page.evaluate(async (id) => {
      try {
        await window.zeno.prsloy.cuaRecovery.resolve(id, "0".repeat(64), "accept_unknown");
        return false;
      } catch {
        return true;
      }
    }, crashActionId);
    expect(invalidChallengeRejected).toBe(true);
    gateway.invalidChallengeRejected = invalidChallengeRejected;
    gateway.crashRetryMode = true;
    await launched.fakeModel.stop();
    await startHostAndTrust(
      launched.page,
      "Start the controlled delayed side effect once; do not repeat it.",
    );
    await expect.poll(() => gateway!.blockedAfterCrash, { timeout: 45_000 }).toBe(true);
    await waitSettled(launched.page);
    expect((await readFile(delayStart, "utf8")).match(/^started$/gmu)).toHaveLength(1);
    expect(
      (await launched.page.evaluate(() => window.zeno.prsloy.cuaRecovery.list()))[0]?.actionId,
    ).toBe(crashActionId);
    await acknowledgeRecovery(launched.page, "cua-recovery-completed");

    // Reuse the same isolated home/profile, but explicitly opt out. The normal host must still answer.
    await launched.app.close();
    await launched.fakeModel.stop();
    launched = await launchZenoApp({
      root,
      tools: "read",
      reply: () => "Ordinary host works after opt-out.",
      env: { PRSLOY_COMPUTER_USE: "0", PRSLOY_CUA_BINARY: "" },
    });
    const optOutRequestsBefore = launched.fakeModel.requests.length;
    await startHostAndTrust(launched.page, "Reply with the exact text ordinary host still works.");
    await expect
      .poll(() => launched!.fakeModel.requests.length)
      .toBeGreaterThan(optOutRequestsBefore);
    await waitSettled(launched.page);
    await expect(
      launched.page
        .getByTestId("markdown-content")
        .getByText("Ordinary host works after opt-out.", { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    gateway.optOutReplyObserved = true;
    expect(
      JSON.parse(await readFile(join(userAgentDir, "settings.json"), "utf8")).extensions,
    ).toContain("+builtin:mcp");
    expect(JSON.stringify(launched.fakeModel.requests.at(-1) ?? "")).not.toMatch(
      /cua_|mcp__cuaComputerUse__/u,
    );
  } finally {
    if (gateway) {
      await writeFile(
        evidencePath,
        JSON.stringify(
          {
            packagedExecutable: packaged,
            cuaDriver: cuaBinary,
            fixturePid: fixture?.pid,
            appPid: gateway.appPid,
            appHwnd: gateway.appHwnd,
            targetWindow: gateway.fixtureWindow,
            secondWindow: gateway.secondaryWindow,
            measuredWindowBounds: gateway.windowBounds,
            topLevelRawToolsAdvertised: gateway.topLevelRawToolsAdvertised,
            directRawToolAttemptCount: gateway.directRawToolAttemptCount,
            directRawAttemptRejected: gateway.rawAttemptRejected,
            strictWrapperSchemas: gateway.strictWrapperSchemas,
            wrapperCalls: gateway.wrapperNames,
            gatewayStepEvidence: gateway.gatewayStepEvidence,
            gatewayErrors: gateway.gatewayErrors,
            gatewayResponseStatuses: gateway.gatewayResponseStatuses,
            crashRecovery: {
              actionId: gateway.crashActionId,
              retryBlockedAfterRestart: gateway.blockedAfterCrash,
              invalidChallengeRejected: gateway.invalidChallengeRejected,
            },
            staleTokenRejected: gateway.staleTokenRejected,
            wrongWindowRejected: gateway.windowMismatchRejected,
            fixtureUnchangedAfterRejectedActions: gateway.rejectedActionsLeftFixtureUntouched,
            screenshotImageUrlSeen: gateway.imageUrlSeen,
            screenshotImageUrlCount: gateway.imageUrlCount,
            readableSavedStateSeen: gateway.readableSavedStateSeen,
            delayedStop: {
              clickedAfterStartMarker: gateway.stopClickedAfterStartMarker,
              CuaClickCalls: gateway.stopClickCount,
              modelRequestsInTurn: gateway.stopModelRequestCount,
              followupModelRequestAborted: gateway.delayFollowupAborted,
              followupModelRequestTimedOut: gateway.delayFollowupTimedOut,
              modelRequestsAtStop: gateway.delayModelRequestCountAtStop,
              followupModelRequestPendingAtStop: gateway.delayFollowupPendingAtStop,
              activeCuaClickCountAtStop: gateway.activeCuaClickCountAtStop,
              fixtureEffectStartedAtUtc: gateway.fixtureEffectStartedAtUtc,
              stopRequestedAtUtc: gateway.stopRequestedAtUtc,
              externalEffectResultAtStop: gateway.delayedResultAtStop,
              startMarkerResult: gateway.stopStartMarker,
              externalEffectResult: gateway.delayedResultAfterStop,
            },
            optOutReplyObserved: gateway.optOutReplyObserved,
            partialListWindowDiagnostic: gateway.listWindowDiagnostics,
          },
          null,
          2,
        ),
      ).catch(() => undefined);
    }
    await launched?.app.close().catch(() => undefined);
    await launched?.fakeModel.stop().catch(() => undefined);
    await gateway?.close();
    try {
      fixture?.kill();
    } catch {
      // The fixture process may already have exited.
    }
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    await rm(build, { recursive: true, force: true }).catch(() => undefined);
  }
});

interface ScriptedGateway {
  baseUrl: string;
  wrapperNames: string[];
  rawAttemptRejected: boolean;
  topLevelRawToolsAdvertised: boolean;
  strictWrapperSchemas: boolean;
  staleTokenRejected: boolean;
  windowMismatchRejected: boolean;
  exactFixtureTargetUsed: boolean;
  imageUrlSeen: boolean;
  imageUrlCount: number;
  readableSavedStateSeen: boolean;
  allTestWindowsOnDisplay2: boolean;
  directRawToolAttemptCount: number;
  modelRequestCount: number;
  distinctSnapshots: boolean;
  rejectedActionsLeftFixtureUntouched: boolean;
  close(): Promise<void>;
}

async function startCuaGateway(
  targetPid: number,
  fixtureOutput: string,
  expectedMarker: string,
): Promise<InternalGateway> {
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
      const body = JSON.parse(raw) as { messages?: Message[]; tools?: RawTool[] };
      gateway.modelRequestCount += 1;
      const messages = body.messages ?? [];
      const lastUserIndex = messages.findLastIndex(
        (message) =>
          message.role === "user" &&
          /Run the packaged CUA fixture flow\.|Start the controlled delayed side effect once; do not repeat it\./u.test(
            allText(message.content),
          ),
      );
      const prompt = allText(messages[lastUserIndex]?.content);
      const turnMessages = messages.slice(lastUserIndex + 1);
      const toolResults = turnMessages.filter((message) => message.role === "tool");
      const step = toolResults.length;
      const lastResult = toolResults.at(-1);
      const lastResultText = allText(lastResult?.content);
      gateway.gatewayStepEvidence.push({
        request: gateway.modelRequestCount,
        step,
        userPromptPrefix: prompt.slice(0, 90),
        priorToolNames: toolResults.map((message) => message.role),
        lastResultType: Array.isArray(lastResult?.content)
          ? (lastResult.content as Array<Record<string, unknown>>).map(
              (item) => item.type ?? typeof item,
            )
          : typeof lastResult?.content,
        lastResultLength: lastResultText.length,
        lastResultLooksError:
          /\b(?:error|failed|exception|not found|rejected)\b|ошиб|не найден|отклон/iu.test(
            lastResultText,
          ),
        fixturePidMentioned: lastResultText.includes(String(targetPid)),
        fixtureTitleMentioned: lastResultText.includes(fixtureTitle),
        snapshotTokenCount: [...lastResultText.matchAll(/\bs[0-9a-f]{8}:\d+\b/giu)].length,
        numericWindowIdCount: [...lastResultText.matchAll(/window_id\s*[:=]\s*\d+/giu)].length,
        imageUrlCount: countImageUrls(lastResult ? [lastResult] : []),
        ...(step >= 2
          ? {
              fixtureToolResultExcerpt: lastResultText
                .replaceAll(fixtureTitle, "<fixture title>")
                .slice(0, 1_600),
            }
          : {}),
      });
      const allMessageText = JSON.stringify(turnMessages);
      const delayedScenario = prompt.includes("Start the controlled delayed side effect");
      if (!delayedScenario && step === 8) gateway.typeResultSeen = true;
      if (!delayedScenario && (step === 8 || step === 10)) {
        const until = Date.now() + 60_000;
        while (!(step === 8 ? gateway.typePendingReleased : gateway.savePendingReleased)) {
          if (Date.now() > until) throw new Error("Owner recovery did not complete");
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      if (delayedScenario) gateway.delayModelRequestCount += 1;
      if (allMessageText.includes('"image_url"')) {
        gateway.imageUrlSeen = true;
        gateway.imageUrlCount += countImageUrls(messages);
      }
      if (allMessageText.includes(`Saved: ${expectedMarker}`))
        gateway.readableSavedStateSeen = true;

      const advertised = (body.tools ?? []).map((tool) => tool.function?.name ?? "");
      if (step === 0) {
        gateway.topLevelRawToolsAdvertised = advertised.some((name) =>
          name.startsWith("mcp__cuaComputerUse__"),
        );
        gateway.strictWrapperSchemas = wrapperSchemasAreNarrow(body.tools ?? []);
      }

      let next: { name: string; args: Record<string, unknown> } | undefined;
      if (delayedScenario) {
        if (step === 0) next = { name: "cua_list_windows", args: {} };
        else if (step === 1) {
          const target = parseWindows(lastResult?.content, [targetPid]).find(
            (window) => window.pid === targetPid && window.title.includes(fixtureTitle),
          );
          if (!target)
            throw new Error("fixture target missing during delayed-side-effect scenario");
          gateway.fixtureWindow = target;
          next = {
            name: "cua_get_window_state",
            args: { pid: target.pid, window_id: target.window_id },
          };
        } else if (step === 2) {
          const snapshot = extractSnapshot(lastResult?.content);
          const delayed = findElementToken(snapshot, /start delayed side effect|fixtureDelayed/iu);
          next = {
            name: "cua_click",
            args: {
              pid: gateway.fixtureWindow!.pid,
              window_id: gateway.fixtureWindow!.window_id,
              element_token: delayed,
            },
          };
        }
      } else if (step === 0) {
        next = { name: "cua_list_windows", args: {} };
      } else if (step === 1) {
        gateway.listWindowDiagnostics = fixtureListDiagnostics(lastResult?.content, targetPid);
        const windows = parseWindows(lastResult?.content, [targetPid]);
        const target = windows.find(
          (window) => window.pid === targetPid && window.title.includes(fixtureTitle),
        );
        const other = windows.find(
          (window) => window.pid === targetPid && window.title.includes(secondFixtureTitle),
        );
        if (!target || !other)
          throw new Error(`Expected both isolated fixture HWNDs; got ${JSON.stringify(windows)}`);
        gateway.exactFixtureTargetUsed = true;
        const measuredBounds = {
          app: readExactWindowBounds(gateway.appHwnd),
          fixture: readExactWindowBounds(target.window_id),
          secondaryFixture: readExactWindowBounds(other.window_id),
        };
        gateway.windowBounds = measuredBounds;
        gateway.allTestWindowsOnDisplay2 = Boolean(
          insideDisplay2(measuredBounds.app) &&
          insideDisplay2(measuredBounds.fixture) &&
          insideDisplay2(measuredBounds.secondaryFixture),
        );
        gateway.fixtureWindow = target;
        gateway.secondaryWindow = other;
        // The direct raw call is scoped to our own fixture HWND and carries only a deliberately invalid token.
        next = {
          name: "mcp__cuaComputerUse__click",
          args: { pid: target.pid, window_id: target.window_id, element_token: "s00000000:1" },
        };
      } else if (step === 2) {
        gateway.rawAttemptRejected =
          /Сырые инструменты Cua доступны только через PRSLOY wrapper|unknown tool|not found|invalid tool|snapshot|element_token/iu.test(
            lastResultText,
          );
        gateway.rejectedActionsLeftFixtureUntouched = !(await readFile(fixtureOutput, "utf8").catch(
          () => "",
        ));
        next = {
          name: "cua_get_window_state",
          args: { pid: gateway.fixtureWindow!.pid, window_id: gateway.fixtureWindow!.window_id },
        };
      } else if (step === 3) {
        gateway.firstSnapshot = extractSnapshot(lastResult?.content);
        next = {
          name: "cua_get_window_state",
          args: { pid: gateway.fixtureWindow!.pid, window_id: gateway.fixtureWindow!.window_id },
        };
      } else if (step === 4) {
        gateway.secondSnapshot = extractSnapshot(lastResult?.content);
        gateway.distinctSnapshots = Boolean(
          gateway.firstSnapshot?.snapshot_id &&
          gateway.secondSnapshot.snapshot_id &&
          gateway.firstSnapshot.snapshot_id !== gateway.secondSnapshot.snapshot_id,
        );
        const input = findElementToken(gateway.firstSnapshot!, /test text|fixtureInput|edit/iu);
        next = {
          name: "cua_type_text",
          args: {
            pid: gateway.fixtureWindow!.pid,
            window_id: gateway.fixtureWindow!.window_id,
            element_token: input,
            text: "MUST-NOT-APPEAR",
          },
        };
      } else if (step === 5) {
        gateway.staleTokenRejected = /последнего snapshot|fresh|snapshot/iu.test(lastResultText);
        const save = findElementToken(gateway.secondSnapshot!, /save test marker|fixtureSave/iu);
        next = {
          name: "cua_click",
          args: {
            pid: gateway.fixtureWindow!.pid,
            window_id: gateway.secondaryWindow!.window_id,
            element_token: save,
          },
        };
      } else if (step === 6) {
        gateway.windowMismatchRejected =
          /текущие pid\/window_id одного окна|current.*window|same.*window/iu.test(lastResultText);
        const fileAfterWrongWindow = await readFile(fixtureOutput, "utf8").catch(() => "");
        gateway.rejectedActionsLeftFixtureUntouched = !fileAfterWrongWindow;
        next = {
          name: "cua_get_window_state",
          args: { pid: gateway.fixtureWindow!.pid, window_id: gateway.fixtureWindow!.window_id },
        };
      } else if (step === 7) {
        gateway.thirdSnapshot = extractSnapshot(lastResult?.content);
        gateway.rejectedActionsLeftFixtureUntouched = Boolean(
          gateway.rejectedActionsLeftFixtureUntouched &&
          gateway.thirdSnapshot.markdown &&
          !gateway.thirdSnapshot.markdown.includes("MUST-NOT-APPEAR") &&
          !gateway.thirdSnapshot.markdown.includes("Saved:"),
        );
        const input = findElementToken(gateway.thirdSnapshot!, /test text|fixtureInput|edit/iu);
        next = {
          name: "cua_type_text",
          args: {
            pid: gateway.fixtureWindow!.pid,
            window_id: gateway.fixtureWindow!.window_id,
            element_token: input,
            text: expectedMarker,
          },
        };
      } else if (step === 8) {
        next = {
          name: "cua_get_window_state",
          args: { pid: gateway.fixtureWindow!.pid, window_id: gateway.fixtureWindow!.window_id },
        };
      } else if (step === 9) {
        if (!lastResultText.includes(expectedMarker))
          throw new Error("fresh snapshot did not read back the typed marker");
        gateway.afterTypeSnapshot = extractSnapshot(lastResult?.content);
        const save = findElementToken(gateway.afterTypeSnapshot, /save test marker|fixtureSave/iu);
        next = {
          name: "cua_click",
          args: {
            pid: gateway.fixtureWindow!.pid,
            window_id: gateway.fixtureWindow!.window_id,
            element_token: save,
          },
        };
      } else if (step === 10) {
        next = {
          name: "cua_get_window_state",
          args: { pid: gateway.fixtureWindow!.pid, window_id: gateway.fixtureWindow!.window_id },
        };
      }

      if (delayedScenario && step === 3 && gateway.crashRetryMode) {
        gateway.blockedAfterCrash = /CUA_RECOVERY_BLOCKED|надёжно записать действие/iu.test(
          lastResultText,
        );
      }
      if (delayedScenario && step === 3 && !gateway.crashRetryMode) {
        gateway.delayFollowupPending = true;
        await new Promise<void>((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(() => {
            gateway.delayFollowupTimedOut = true;
            finish();
          }, 20_000);
          res.once("close", () => {
            if (res.writableEnded) return;
            gateway.delayFollowupAborted = true;
            finish();
          });
        });
        if (gateway.delayFollowupAborted) return;
      }

      gateway.gatewayResponseStatuses.push(200);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const send = (delta: Record<string, unknown>, finish: string | null = null) => {
        res.write(
          `data: ${JSON.stringify({ id: "packaged-cua-e2e", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        );
      };
      send({ role: "assistant", content: "" });
      if (next) {
        if (delayedScenario) {
          gateway.delayWrapperNames.push(next.name);
          if (next.name === "cua_click") {
            gateway.delayClickCount += 1;
            gateway.delayClickRequested = true;
          }
        } else if (next.name.startsWith("cua_")) gateway.wrapperNames.push(next.name);
        else gateway.directRawToolAttemptCount += 1;
        send({
          tool_calls: [
            {
              index: 0,
              id: `cua-call-${step}`,
              type: "function",
              function: { name: next.name, arguments: JSON.stringify(next.args) },
            },
          ],
        });
        send({}, "tool_calls");
      } else {
        send({ content: "Packaged CUA fixture flow complete; saved state was observed." });
        send({}, "stop");
      }
      res.end("data: [DONE]\n\n");
    })().catch((error) => {
      gateway.gatewayResponseStatuses.push(500);
      gateway.gatewayErrors.push(String(error).replaceAll(fixtureTitle, "<fixture title>"));
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("scripted CUA gateway did not bind");
  const gateway = Object.assign({
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    wrapperNames: [] as string[],
    rawAttemptRejected: false,
    topLevelRawToolsAdvertised: false,
    strictWrapperSchemas: false,
    staleTokenRejected: false,
    windowMismatchRejected: false,
    exactFixtureTargetUsed: false,
    imageUrlSeen: false,
    imageUrlCount: 0,
    readableSavedStateSeen: false,
    allTestWindowsOnDisplay2: false,
    directRawToolAttemptCount: 0,
    modelRequestCount: 0,
    distinctSnapshots: false,
    rejectedActionsLeftFixtureUntouched: false,
    delayWrapperNames: [] as string[],
    delayClickCount: 0,
    delayClickRequested: false,
    delayModelRequestCount: 0,
    delayFollowupPending: false,
    delayFollowupAborted: false,
    delayFollowupTimedOut: false,
    delayModelRequestCountAtStop: 0,
    delayFollowupPendingAtStop: false,
    appPid: 0,
    listWindowDiagnostics: undefined,
    windowBounds: {},
    stopClickedAfterStartMarker: false,
    delayedResultAfterStop: "",
    delayedResultAtStop: "",
    fixtureEffectStartedAtUtc: "",
    stopRequestedAtUtc: "",
    activeCuaClickCountAtStop: 0,
    optOutReplyObserved: false,
    gatewayStepEvidence: [] as Record<string, unknown>[],
    gatewayErrors: [] as string[],
    gatewayResponseStatuses: [] as number[],
    typePendingReleased: false,
    typeResultSeen: false,
    savePendingReleased: false,
    crashRetryMode: false,
    blockedAfterCrash: false,
    crashActionId: "",
    invalidChallengeRejected: false,
    stopClickCount: 0,
    stopModelRequestCount: 0,
    stopStartMarker: "",
    close: async () => {
      server.closeAllConnections();
      server.close();
      await new Promise<void>((resolve) => server.once("close", resolve));
    },
  }) as InternalGateway;
  return gateway;
}

async function acknowledgeRecovery(
  page: import("playwright").Page,
  resolution: "cua-recovery-completed" | "cua-recovery-accept-unknown",
): Promise<void> {
  const button = page.getByRole("button", { name: /Проверить действие Cua|Review Cua action/u });
  await expect(button).toBeVisible({ timeout: 30_000 });
  await button.click();
  const dialog = page.getByTestId("cua-recovery-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("cua-recovery-acknowledge")).toBeEnabled({ timeout: 30_000 });
  await page.getByTestId("cua-recovery-acknowledge").check();
  await page.getByTestId(resolution).click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
}

async function startHostAndTrust(page: import("playwright").Page, prompt: string): Promise<void> {
  await page.getByTestId("zeno-app").waitFor({ state: "visible" });
  await page.waitForSelector('[data-testid="zeno-app"][data-bootstrap-ready="true"]', {
    timeout: 120_000,
  });
  const trust = page.getByTestId("project-trust-dialog-trust");
  if (await trust.isVisible().catch(() => false)) await trust.click();
  const snapshot = page.getByTestId("runtime-snapshot").first();
  const current = await snapshot.textContent().catch(() => "");
  if (!/"runtimeId":\s*"([^"]+)"/u.test(current ?? "")) {
    await page.getByTestId("start-host").click({ force: true });
    if (await trust.isVisible().catch(() => false)) await trust.click();
    await expect(snapshot).toContainText("runtimeId", { timeout: 60_000 });
  }
  await expect(page.getByTestId("host-status").first()).toContainText(
    /Agent Host ready|Agent Host restarted|Agent settled|就绪/u,
    { timeout: 45_000 },
  );
  await page.getByTestId("prompt-input").click();
  await page.getByTestId("prompt-input").pressSequentially(prompt);
  await page.getByTestId("send-prompt").click();
}

function wrapperSchemasAreNarrow(tools: RawTool[]): boolean {
  const wrappers = new Map(
    tools.map((tool) => [tool.function?.name ?? "", tool.function?.parameters]),
  );
  const expected: Record<string, { properties: string[]; required: string[] }> = {
    cua_list_apps: { properties: [], required: [] },
    cua_list_windows: { properties: ["pid"], required: [] },
    cua_get_window_state: { properties: ["pid", "window_id"], required: ["pid", "window_id"] },
    cua_click: {
      properties: ["element_token", "pid", "window_id"],
      required: ["element_token", "pid", "window_id"],
    },
    cua_type_text: {
      properties: ["element_token", "pid", "text", "window_id"],
      required: ["element_token", "pid", "text", "window_id"],
    },
  };
  for (const [name, expectedSchema] of Object.entries(expected)) {
    const schema = wrappers.get(name);
    if (!schema || schema.additionalProperties !== false) return false;
    const actual = Object.keys(
      (schema.properties as Record<string, unknown> | undefined) ?? {},
    ).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expectedSchema.properties)) return false;
    const required = Array.isArray(schema.required)
      ? [...(schema.required as string[])].sort()
      : [];
    if (JSON.stringify(required) !== JSON.stringify(expectedSchema.required)) return false;
  }
  const tokenSchema = (
    wrappers.get("cua_click")?.properties as Record<string, Record<string, unknown>> | undefined
  )?.element_token;
  if (tokenSchema?.pattern !== "^s[0-9a-f]{8}:[0-9]+$") return false;
  return true;
}

function allText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(allText).join("\n");
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return [
      typeof row.text === "string" ? row.text : "",
      ...Object.values(row)
        .filter((item) => item !== row.text)
        .map(allText),
    ].join("\n");
  }
  return "";
}

function allObjects(
  value: unknown,
  found: Record<string, unknown>[] = [],
): Record<string, unknown>[] {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      allObjects(parsed, found);
    } catch {
      // Cua also provides a Markdown view; its token rows are parsed separately.
    }
  } else if (Array.isArray(value)) {
    for (const item of value) allObjects(item, found);
  } else if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    found.push(row);
    for (const item of Object.values(row)) allObjects(item, found);
  }
  return found;
}

function parseWindows(content: unknown, allowedPids: readonly number[]): WindowRow[] {
  const allowed = new Set(allowedPids);
  const rows: WindowRow[] = [];
  for (const row of allObjects(content)) {
    const pid = row.pid;
    const windowId = row.window_id ?? row.windowId;
    const title = row.title ?? row.window_title;
    if (
      Number.isSafeInteger(pid) &&
      allowed.has(Number(pid)) &&
      Number.isSafeInteger(windowId) &&
      typeof title === "string"
    ) {
      const bounds =
        row.bounds && typeof row.bounds === "object"
          ? (row.bounds as Record<string, unknown>)
          : undefined;
      const parsedBounds =
        bounds && [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
          ? {
              x: Number(bounds.x),
              y: Number(bounds.y),
              width: Number(bounds.width),
              height: Number(bounds.height),
            }
          : undefined;
      rows.push({
        pid: Number(pid),
        window_id: Number(windowId),
        title,
        ...(parsedBounds ? { bounds: parsedBounds } : {}),
      });
    }
  }
  const listedText = allText(content).replace(/\\(["\\])/gu, "$1");
  const listedWindow = /\(pid\s+(\d+)\)\s+["“]([^"”]+)["”]\s+\[window_id:\s*(\d+)\]/gimu;
  for (const match of listedText.matchAll(listedWindow)) {
    const pid = Number(match[1]);
    const title = match[2];
    const windowId = Number(match[3]);
    if (
      Number.isSafeInteger(pid) &&
      allowed.has(pid) &&
      Number.isSafeInteger(windowId) &&
      title &&
      !rows.some((row) => row.pid === pid && row.window_id === windowId)
    ) {
      rows.push({ pid, window_id: windowId, title });
    }
  }
  return rows;
}

function fixtureListDiagnostics(content: unknown, fixturePid: number): unknown {
  const objects = allObjects(content);
  const rows = objects
    .filter((row) => {
      const title = row.title ?? row.window_title ?? row.name;
      return row.pid === fixturePid || (typeof title === "string" && title.includes(fixtureTitle));
    })
    .map((row) => ({
      keys: Object.keys(row).sort(),
      pid: row.pid,
      window_id: row.window_id ?? row.windowId,
      title: row.title ?? row.window_title ?? row.name,
      bounds: row.bounds,
    }));
  const text = allText(content);
  const snippets = [...text.matchAll(/.{0,180}PRSLOY 104 Packaged Cua Fixture.{0,180}/giu)].map(
    (match) => match[0],
  );
  return {
    expectedFixturePid: fixturePid,
    contentTypes: Array.isArray(content)
      ? content.map((item) =>
          item && typeof item === "object" ? (item as Record<string, unknown>).type : typeof item,
        )
      : [typeof content],
    matchingFixtureRows: rows,
    fixtureTextSnippets: snippets,
    regexFixtureMatches: [
      ...text
        .replace(/\\(["\\])/gu, "$1")
        .matchAll(/\(pid\s+(\d+)\)\s+["“]([^"”]+)["”]\s+\[window_id:\s*(\d+)\]/gimu),
    ]
      .filter((match) => Number(match[1]) === fixturePid || match[2]?.includes(fixtureTitle))
      .map((match) => match.slice(1)),
  };
}

function extractSnapshot(content: unknown): Snapshot {
  const objects = allObjects(content);
  const structured = objects.find((row) => typeof row.snapshot_id === "string");
  const snapshot: Snapshot = {
    markdown: allText(content),
    ...(structured ? { snapshot_id: String(structured.snapshot_id) } : {}),
  };
  const elements = objects.find((row) => Array.isArray(row.elements))?.elements;
  if (Array.isArray(elements)) snapshot.elements = elements as Record<string, unknown>[];
  if (!snapshot.snapshot_id) {
    const match = allText(content).match(/\bs[0-9a-f]{8}\b/iu);
    if (match) snapshot.snapshot_id = match[0];
  }
  return snapshot;
}

function findElementToken(snapshot: Snapshot, label: RegExp): string {
  const element = snapshot.elements?.find((row) => {
    const description = JSON.stringify(row);
    return typeof row.element_token === "string" && label.test(description);
  });
  if (element && typeof element.element_token === "string") return element.element_token;
  const text = snapshot.markdown ?? allText(snapshot);
  const lines = text.split(/\r?\n/u);
  const line = lines.find((item) => label.test(item));
  const index = line?.match(/^\s*(?:-\s*)?\[(\d+)\]/u)?.[1];
  if (snapshot.snapshot_id && index) return `${snapshot.snapshot_id}:${index}`;
  throw new Error(
    `Could not find snapshot token matching ${label} in Cua response: ${text.slice(0, 5000)}`,
  );
}

function countImageUrls(messages: Message[]): number {
  return (JSON.stringify(messages).match(/"image_url"/giu) ?? []).length;
}

function insideDisplay2(bounds: { x: number; y: number; width: number; height: number }): boolean {
  return Boolean(
    bounds.x >= 2560 &&
    bounds.y >= 0 &&
    bounds.x + bounds.width <= 4480 &&
    bounds.y + bounds.height <= 1080,
  );
}

function readExactWindowBounds(hwnd: number): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const { bounds } = readExactWindowInfo(hwnd);
  return bounds;
}

function readExactWindowInfo(hwnd: number): {
  pid: number;
  bounds: { x: number; y: number; width: number; height: number };
} {
  if (!Number.isSafeInteger(hwnd) || hwnd <= 0) throw new Error(`Invalid test HWND: ${hwnd}`);
  const script = `$source = @'
using System;
using System.Runtime.InteropServices;
public static class PrsloyTestWindowBounds {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll", SetLastError = true)] private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll", SetLastError = true)] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  public static int[] Read(long handle) {
    uint pid;
    RECT rect;
    if (GetWindowThreadProcessId(new IntPtr(handle), out pid) == 0) throw new InvalidOperationException("GetWindowThreadProcessId failed: " + Marshal.GetLastWin32Error());
    if (!GetWindowRect(new IntPtr(handle), out rect)) throw new InvalidOperationException("GetWindowRect failed: " + Marshal.GetLastWin32Error());
    return new int[] { (int)pid, rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top };
  }
}
'@
Add-Type -TypeDefinition $source -ErrorAction Stop
[PrsloyTestWindowBounds]::Read(${hwnd}) | ConvertTo-Json -Compress`;
  const output = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  const parsed = JSON.parse(output) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== 5 || !parsed.every(Number.isFinite))
    throw new Error(`GetWindowRect returned invalid geometry for fixture HWND ${hwnd}`);
  const [pid, x, y, width, height] = parsed as [number, number, number, number, number];
  return { pid, bounds: { x, y, width, height } };
}

async function waitForFixtureProcess(pid: number | undefined): Promise<void> {
  if (!pid) throw new Error("fixture process failed to start");
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const windows = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty MainWindowTitle`,
      ],
      { encoding: "utf8", windowsHide: true },
    ).trim();
    if (windows.includes(fixtureTitle)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Cua fixture main window did not appear");
}
