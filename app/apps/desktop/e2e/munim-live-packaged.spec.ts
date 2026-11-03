import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { expect, launchZenoApp, test, waitSettled } from "./fixtures.ts";
import { startLiveMunimProxy, type LiveMunimProxy } from "./live-munim-proxy.ts";

const packaged = process.env.PRSLOY_E2E_PACKAGED?.trim();
const munim = process.env.PRSLOY_MUNIM_BINARY?.trim();
const encryptedKey = process.env.PRSLOY_E2E_GATEWAY_ENCRYPTED_KEY?.trim();
const upstreamUrl = "https://api.prsloy.online/v1/chat/completions";
const model = "gpt-6.1-sol";
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
type RecoveryItem = {
  actionId: string;
  backend: string;
  pid: number;
  kind: string;
  status: string;
};

/**
 * Opt-in, paid live-model test. Uses only synthetic prompts/fixture context and a private,
 * temporary copy of the encrypted key plus its synthetic Electron Local State. Never run in CI.
 */
test("packaged PRSLOY live GPT drives only the isolated Munim fixture through two owner recoveries", async () => {
  test.skip(process.env.PRSLOY_E2E_LIVE_GATEWAY !== "1", "requires explicit paid gateway opt-in");
  test.skip(process.platform !== "win32", "requires Windows native window checks");
  test.skip(!packaged, "requires PRSLOY_E2E_PACKAGED pointing to a packaged Windows executable");
  test.skip(!munim, "requires PRSLOY_MUNIM_BINARY pointing to the verified real Munim executable");
  test.skip(!encryptedKey, "requires the locally staged encrypted gateway key path");
  test.skip(
    Boolean(process.env.PRSLOY_E2E_SESSIONS?.trim()),
    "session export must stay disabled for this live fixture",
  );
  test.setTimeout(720_000);

  assertInsideDisplay2(fixtureBounds);
  assertInsideDisplay2(appBounds);
  if (!display2StillMatches())
    throw new Error("Physical DISPLAY2 geometry is not the expected safe target");

  const tempRoot = resolve(tmpdir());
  const workspace = await mkdtemp(join(tempRoot, "prsloy-munim-live-workspace-"));
  const root = await mkdtemp(join(tempRoot, "prsloy-munim-live-profile-"));
  const fixtureBuild = join(root, "fixture-build");
  const published = join(fixtureBuild, "publish");
  const obj = join(fixtureBuild, "obj");
  const bin = join(fixtureBuild, "bin");
  const fixtureOutput = join(root, "fixture-result.txt");
  const userData = join(root, "electron-userData");
  const stateDir = join(userData, "prsloy");
  const userAgentDir = join(root, "home", ".pi", "agent");
  const marker = `PRSLOY-MUNIM-LIVE-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const prompts: [string, string, string] = [
    `Turn 1: use only the synthetic Munim fixture PID=<FIXTURE_PID>, HWND=<FIXTURE_HWND>, title="${fixtureTitle}". First call munim_list_apps, then get a fresh munim_get_app_state for that exact PID. Type exactly "${marker}" into "Test text". Do not save. Stop for owner recovery after typing.`,
    `Owner recovery confirmed after turn 1. Turn 2: first call munim_list_apps, then take a fresh munim_get_app_state snapshot of only PID=<FIXTURE_PID>, HWND=<FIXTURE_HWND>. Confirm the exact marker "${marker}" is in "Test text", then click only "Save test marker" once. Stop for owner recovery after the click.`,
    `Owner recovery confirmed after turn 2. Turn 3: first call munim_list_apps, then inspect only PID=<FIXTURE_PID>, HWND=<FIXTURE_HWND> with a fresh munim_get_app_state snapshot and report whether status is exactly "Saved: ${marker}". Do not act.`,
  ];

  let fixture: ReturnType<typeof spawn> | undefined;
  let launched: Awaited<ReturnType<typeof launchZenoApp>> | undefined;
  let proxy: LiveMunimProxy | undefined;
  let callbackValidations = 0;
  let callbackFailures = 0;
  let ownerResolvedTypeUnknown = false;
  let ownerResolvedSaveCompleted = false;
  let completed = false;
  let cleanupOk = true;
  let fixturePid = 0;
  let fixtureHwnd = 0;
  let appPid = 0;
  let appHwnd = 0;
  let initialFixtureWindow: NativeWindow | undefined;
  try {
    assertChildPath(tempRoot, workspace);
    assertChildPath(tempRoot, root);
    await assertNoWorkspaceInstructions(workspace, tempRoot);
    await mkdir(stateDir, { recursive: true });
    await mkdir(userAgentDir, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await mkdir(published, { recursive: true });
    await writeFile(
      join(userAgentDir, "settings.json"),
      JSON.stringify({ extensions: ["+builtin:mcp"] }),
    );
    await writeFile(
      join(userData, "zeno-desktop.json"),
      JSON.stringify({ recentWorkspaces: [], window: appBounds }),
    );
    await writeFile(
      join(workspace, "README.md"),
      "Synthetic Munim live integration fixture. No real customer data.\n",
    );

    // Copy opaque encrypted bytes and the matching synthetic Local State only. Never read or log key contents.
    const encryptedKeyPath = resolve(encryptedKey!);
    const syntheticLocalStatePath = join(
      dirname(encryptedKeyPath),
      "electron-userdata",
      "Local State",
    );
    try {
      await copyFile(encryptedKeyPath, join(stateDir, "gateway-key.bin"));
      await copyFile(syntheticLocalStatePath, join(userData, "Local State"));
    } catch {
      throw new Error(
        "Could not stage the isolated encrypted gateway credential and synthetic Local State",
      );
    }

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
    const fixtureDll = join(published, "PrsloyMunimIsolatedFixture.dll");
    fixture = spawn(
      "dotnet",
      [fixtureDll, fixtureOutput, String(fixtureBounds.x), String(fixtureBounds.y)],
      {
        stdio: "ignore",
        windowsHide: true,
      },
    );
    fixturePid = fixture.pid ?? 0;
    if (!fixturePid) throw new Error("Isolated Munim fixture process failed to start");
    initialFixtureWindow = await waitForExactWindow(fixturePid, fixtureTitle, fixtureBounds);
    fixtureHwnd = initialFixtureWindow.hwnd;

    const syntheticPrompts = prompts.map((prompt) =>
      prompt
        .replaceAll("<FIXTURE_PID>", String(fixturePid))
        .replaceAll("<FIXTURE_HWND>", String(fixtureHwnd)),
    ) as [string, string, string];
    const validateFixtureTarget = async (): Promise<boolean> => {
      callbackValidations += 1;
      const valid = await validateOwnedTargets();
      if (!valid) callbackFailures += 1;
      return valid;
    };
    proxy = await startLiveMunimProxy({
      fixturePid,
      fixtureHwnd,
      fixtureTitle,
      syntheticPrompts,
      syntheticMarker: marker,
      allowedModel: model,
      upstreamUrl,
      liveEnabled: true,
      maxRequests: 12,
      maxOutputTokens: 512,
      maxTotalOutputTokens: 6144,
      maxTotalOutboundBytes: 300_000,
      timeoutMs: 90_000,
      validateFixtureTarget,
    });

    await writeFile(
      join(stateDir, "state.json"),
      JSON.stringify({
        baseUrl: proxy.baseUrl,
        models: { ids: [model], checkedAt: new Date().toISOString() },
      }),
    );
    launched = await launchZenoApp({
      root,
      workspacePath: workspace,
      tools: "read,munim_list_apps,munim_get_app_state,munim_type_text,munim_click",
      model: { provider: "prsloy", id: model },
      modelInput: ["text"],
      env: {
        PRSLOY_COMPUTER_USE: "1",
        PRSLOY_MUNIM_BINARY: munim!,
        PRSLOY_CUA_BINARY: "",
        PRSLOY_BALANCE_WARN_RUB: "0",
        ZENO_NO_AUTO_RESUME: "1",
      },
    });

    appPid = await launched.app.evaluate(() => process.pid);
    if (!appPid) throw new Error("Packaged PRSLOY PID unavailable");
    const appWindow = await waitForAppWindow(launched, appPid);
    appHwnd = appWindow.hwnd;
    if (!(await validateOwnedTargets()))
      throw new Error("Initial fixture/app PID-HWND-bounds monitor preflight failed");

    const mcp = JSON.parse(await readFile(join(launched.agentDir, "mcp.json"), "utf8")) as {
      mcpServers?: Record<string, { command?: string }>;
    };
    expect(mcp.mcpServers?.munimComputerUse?.command).toBe(munim);
    await launched.fakeModel.stop();
    const modelPath = join(launched.agentDir, "models.json");
    const registry = JSON.parse(await readFile(modelPath, "utf8")) as {
      providers?: Record<
        string,
        { baseUrl?: string; models?: Array<{ id?: string; maxTokens?: number; input?: string[] }> }
      >;
    };
    const modelEntry = registry.providers?.prsloy?.models?.find((entry) => entry.id === model);
    if (!modelEntry) throw new Error("Isolated profile did not configure the selected live model");
    expect(registry.providers?.prsloy?.baseUrl).toBe(proxy.baseUrl);
    modelEntry.maxTokens = 512;
    modelEntry.input = ["text"];
    await writeFile(modelPath, JSON.stringify(registry));

    await launched.page.waitForSelector('[data-testid="zeno-app"][data-bootstrap-ready="true"]', {
      timeout: 120_000,
    });
    const runtime = launched.page.getByTestId("runtime-snapshot").first();
    if (!/"runtimeId":\s*"([^"]+)"/u.test((await runtime.textContent().catch(() => "")) ?? "")) {
      await launched.page.getByTestId("start-host").click({ force: true });
      await expect(runtime).toContainText("runtimeId", { timeout: 60_000 });
    }
    await expect(launched.page.getByTestId("host-status").first()).toContainText(
      /Agent Host ready|Agent Host restarted|Agent settled|就绪/u,
      { timeout: 45_000 },
    );
    const trust = launched.page.getByTestId("project-trust-dialog-trust");
    if (await trust.isVisible().catch(() => false)) await trust.click();
    const assertProxyHealthy = () => {
      const state = proxy!.evidence();
      const rejection = state.rejected[0];
      if (rejection)
        throw new Error(
          `Isolated Munim proxy rejected request: ${rejection} ${state.invalidSseDetails[0] ?? ""} ${state.upstreamFailures.map(formatUpstreamFailure).join(",")}`,
        );
    };

    await sendPrompt(launched.page, syntheticPrompts[0]);
    await expect
      .poll(
        async () => {
          assertProxyHealthy();
          return (await listRecovery(launched!.page)).length;
        },
        { timeout: 180_000 },
      )
      .toBe(1);
    await waitSettled(launched.page);
    const typedPending = await listRecovery(launched.page);
    expect(typedPending).toHaveLength(1);
    expect(typedPending[0]).toMatchObject({
      backend: "munim",
      pid: fixturePid,
      kind: "type_text",
      status: "unknown",
    });
    expect(await readFile(fixtureOutput, "utf8").catch(() => undefined)).toBeUndefined();
    await acknowledgeRecovery(launched.page, "cua-recovery-accept-unknown");
    ownerResolvedTypeUnknown = true;
    expect(await listRecovery(launched.page)).toEqual([]);

    await sendPrompt(launched.page, syntheticPrompts[1]);
    await expect
      .poll(
        () => {
          assertProxyHealthy();
          return proxy!.evidence().markerReadBack;
        },
        { timeout: 180_000 },
      )
      .toBe(true);
    await expect
      .poll(
        () => {
          assertProxyHealthy();
          return readFile(fixtureOutput, "utf8").catch(() => "");
        },
        { timeout: 30_000 },
      )
      .toBe(marker);
    await expect
      .poll(
        async () => {
          assertProxyHealthy();
          return (await listRecovery(launched!.page)).length;
        },
        { timeout: 60_000 },
      )
      .toBe(1);
    await waitSettled(launched.page);
    const savedPending = await listRecovery(launched.page);
    expect(savedPending).toHaveLength(1);
    expect(savedPending[0]).toMatchObject({
      backend: "munim",
      pid: fixturePid,
      kind: "click",
      status: "unknown",
    });
    expect(await readFile(fixtureOutput, "utf8")).toBe(marker);
    await acknowledgeRecovery(launched.page, "cua-recovery-completed");
    ownerResolvedSaveCompleted = true;
    expect(await listRecovery(launched.page)).toEqual([]);

    const requestsBeforeFinalTurn = proxy.evidence().requests;
    const toolCallsBeforeFinalTurn = proxy.evidence().toolCalls;
    expect(proxy.evidence().savedStatusReadBack).toBe(false);
    await sendPrompt(launched.page, syntheticPrompts[2]);
    await expect
      .poll(
        () => {
          assertProxyHealthy();
          return proxy!.evidence().requests;
        },
        { timeout: 180_000 },
      )
      .toBeGreaterThan(requestsBeforeFinalTurn);
    await expect
      .poll(
        () => {
          assertProxyHealthy();
          return proxy!.evidence().toolCalls;
        },
        { timeout: 180_000 },
      )
      .toBeGreaterThan(toolCallsBeforeFinalTurn);
    await expect
      .poll(
        () => {
          assertProxyHealthy();
          return proxy!.evidence().savedStatusReadBack;
        },
        { timeout: 180_000 },
      )
      .toBe(true);
    await waitSettled(launched.page);
    const finalText = await launched.page.getByTestId("markdown-content").last().innerText();
    expect(finalText).toContain(marker);
    expect(finalText).toMatch(/saved|сохран/iu);

    const evidence = proxy.evidence();
    expect(evidence.requests).toBeGreaterThan(0);
    expect(evidence.requests).toBeLessThanOrEqual(12);
    expect(evidence.outboundBytes).toBeLessThanOrEqual(300_000);
    expect(evidence.outputTokensReported).toBeLessThanOrEqual(12 * 512);
    expect(evidence.imageUploads).toBe(0);
    expect(evidence.rejected).toEqual([]);
    expect(evidence.markerReadBack).toBe(true);
    expect(evidence.savedStatusReadBack).toBe(true);
    expect(evidence.toolSequence).toEqual([
      "munim_list_apps",
      "munim_get_app_state",
      "munim_type_text",
      "munim_list_apps",
      "munim_get_app_state",
      "munim_click",
      "munim_list_apps",
      "munim_get_app_state",
    ]);
    expect(ownerResolvedTypeUnknown).toBe(true);
    expect(ownerResolvedSaveCompleted).toBe(true);
    expect(callbackFailures).toBe(0);
    expect(callbackValidations).toBeGreaterThanOrEqual(evidence.toolCalls);
    expect(await readFile(fixtureOutput, "utf8")).toBe(marker);
    if (!(await validateOwnedTargets()))
      throw new Error("Final fixture/app PID-HWND-bounds monitor preflight failed");
    completed = true;
  } finally {
    const evidence = proxy?.evidence();
    if (evidence) {
      await writeFile(
        test.info().outputPath("munim-live-packaged-evidence.json"),
        JSON.stringify({
          completed,
          model,
          upstream: "api.prsloy.online",
          requestCount: evidence.requests,
          toolCallCount: evidence.toolCalls,
          toolSequence: evidence.toolSequence,
          outputTokensReported: evidence.outputTokensReported,
          usageUnavailableResponses: evidence.usageUnavailableResponses,
          outboundBytes: evidence.outboundBytes,
          imageUploads: evidence.imageUploads,
          imageUploadsEvidence: "zero by text-only proxy construction; not separately measured",
          proxyRejections: evidence.rejected,
          invalidSseDetails: evidence.invalidSseDetails,
          upstreamFailures: evidence.upstreamFailures.map(projectUpstreamFailure),
          ignoredModelRequests: evidence.ignoredModelRequests,
          markerReadBack: evidence.markerReadBack,
          savedStatusReadBack: evidence.savedStatusReadBack,
          callbackValidations,
          callbackFailures,
          fixturePid,
          fixtureHwnd,
          fixtureBounds,
          appPid,
          appHwnd,
          appBounds,
          physicalDisplay2PreflightPassed: display2StillMatches(),
          ownerResolvedTypeUnknown,
          ownerResolvedSaveCompleted,
          savedMarkerFile: await readFile(fixtureOutput, "utf8").catch(() => "absent"),
          sessionExportConfigured: false,
        }),
      ).catch(() => undefined);
    }
    let appClosed = true;
    if (launched) {
      appClosed = await boundedCleanup(() => launched!.app.close());
      if (!(await boundedCleanup(() => launched!.fakeModel.stop()))) cleanupOk = false;
    }
    if (proxy && !(await boundedCleanup(() => proxy!.close()))) cleanupOk = false;
    if (fixture) {
      const exited = once(fixture, "exit").catch(() => undefined);
      if (fixture.exitCode === null && fixture.signalCode === null) fixture.kill();
      if (fixture.exitCode === null && fixture.signalCode === null)
        await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 2_000))]);
    }
    const credentialCopies = [join(stateDir, "gateway-key.bin"), join(userData, "Local State")];
    for (const copy of credentialCopies) {
      await rm(copy, { force: true }).catch(() => {
        cleanupOk = false;
      });
      if (
        await access(copy).then(
          () => true,
          (error: NodeJS.ErrnoException) => error.code !== "ENOENT",
        )
      )
        cleanupOk = false;
    }
    if (appClosed && (!fixture || fixture.exitCode !== null || fixture.signalCode !== null)) {
      await rm(root, { recursive: true, force: true }).catch(() => {
        cleanupOk = false;
      });
      await rm(workspace, { recursive: true, force: true }).catch(() => {
        cleanupOk = false;
      });
    } else {
      cleanupOk = false;
    }
    if (!cleanupOk)
      test.info().annotations.push({
        type: "cleanup",
        description:
          "Owned process or isolated credential cleanup failed; temporary profile retained if necessary.",
      });
  }
  expect(cleanupOk, "Owned processes and isolated credential copies must be cleaned up").toBe(true);

  async function validateOwnedTargets(): Promise<boolean> {
    if (
      !display2StillMatches() ||
      !fixture ||
      fixture.exitCode !== null ||
      fixture.signalCode !== null
    )
      return false;
    if (fixture.pid !== fixturePid || !launched || !appPid || !appHwnd || !fixtureHwnd)
      return false;
    try {
      const fixtureInventory = readProcessWindowInventory(fixturePid, fixtureTitle);
      const fixtureWindow = fixtureInventory.matchingWindows[0];
      if (
        fixtureInventory.visibleCount !== 1 ||
        fixtureInventory.matchingWindows.length !== 1 ||
        !fixtureWindow ||
        fixtureWindow.hwnd !== fixtureHwnd ||
        !boundsEqual(fixtureWindow, fixtureBounds) ||
        !insideDisplay2(fixtureWindow)
      )
        return false;
      const appInventory = readProcessWindowInventory(appPid);
      const appWindow = appInventory.matchingWindows[0];
      if (
        appInventory.visibleCount !== 1 ||
        appInventory.matchingWindows.length !== 1 ||
        !appWindow ||
        appWindow.hwnd !== appHwnd ||
        !insideDisplay2(appWindow)
      )
        return false;
      if ((await launched.app.evaluate(() => process.pid).catch(() => undefined)) !== appPid)
        return false;
      const electronWindow = await launched.app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        const handle = window?.getNativeWindowHandle();
        return window && handle?.length
          ? { hwnd: Number(handle.readBigUInt64LE()), bounds: window.getBounds() }
          : undefined;
      });
      return Boolean(
        electronWindow?.hwnd === appHwnd &&
        boundsEqual(electronWindow.bounds, appBounds) &&
        insideDisplay2(electronWindow.bounds),
      );
    } catch {
      return false;
    }
  }
});

type UpstreamFailure = ReturnType<LiveMunimProxy["evidence"]>["upstreamFailures"][number];

function formatUpstreamFailure(failure: UpstreamFailure): string {
  const projected = projectUpstreamFailure(failure);
  return projected.kind === "http_status" ? `http_status:${projected.status}` : projected.kind;
}

function projectUpstreamFailure(failure: UpstreamFailure): UpstreamFailure {
  switch (failure.kind) {
    case "http_status":
      return {
        kind: "http_status",
        status:
          Number.isSafeInteger(failure.status) && failure.status >= 100 && failure.status <= 599
            ? failure.status
            : 0,
      };
    case "url_mismatch":
    case "no_body":
    case "timeout":
    case "network":
    case "response_limit":
      return { kind: failure.kind };
  }
}

async function sendPrompt(page: import("playwright").Page, prompt: string): Promise<void> {
  await page.getByTestId("prompt-input").fill(prompt);
  await page.getByTestId("send-prompt").click();
}

async function acknowledgeRecovery(
  page: import("playwright").Page,
  resolution: "cua-recovery-completed" | "cua-recovery-accept-unknown",
): Promise<void> {
  const open = page.getByRole("button", {
    name: /Проверить действие (?:Cua|Munim)|Review (?:Cua|Munim) action/u,
  });
  await expect(open).toBeVisible({ timeout: 90_000 });
  await open.click();
  const dialog = page.getByTestId("cua-recovery-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("cua-recovery-acknowledge")).toBeEnabled({ timeout: 30_000 });
  await page.getByTestId("cua-recovery-acknowledge").check();
  await page.getByTestId(resolution).click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
}

async function listRecovery(page: import("playwright").Page): Promise<RecoveryItem[]> {
  return page.evaluate(() => window.zeno.prsloy.cuaRecovery.list()) as Promise<RecoveryItem[]>;
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
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error("Munim fixture did not produce the expected visible HWND on DISPLAY2");
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
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error("Packaged PRSLOY PID/HWND/bounds preflight failed");
}

function readProcessWindowInventory(pid: number, expectedTitle?: string): WindowInventory {
  const titleLiteral =
    expectedTitle === undefined ? "$null" : "'" + expectedTitle.replaceAll("'", "''") + "'";
  const csharp =
    "using System;using System.Collections.Generic;using System.Runtime.InteropServices;using System.Text;" +
    "public static class PrsloyMunimLiveWindows{public delegate bool EnumWindowsProc(IntPtr h,IntPtr l);" +
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
    "$cb=[PrsloyMunimLiveWindows+EnumWindowsProc]{param([IntPtr]$h,[IntPtr]$l);" +
    "[uint32]$p=0;[void][PrsloyMunimLiveWindows]::GetWindowThreadProcessId($h,[ref]$p);" +
    "if($p -ne $targetPid){return $true};$r=[PrsloyMunimLiveWindows+RECT]::new();" +
    "if(-not [PrsloyMunimLiveWindows]::GetWindowRect($h,[ref]$r)){return $true};" +
    "$s=[System.Text.StringBuilder]::new(1024);[void][PrsloyMunimLiveWindows]::GetWindowText($h,$s,$s.Capacity);" +
    "$rows.Add([pscustomobject]@{hwnd=$h.ToInt64();pid=$p;title=$s.ToString();visible=[PrsloyMunimLiveWindows]::IsWindowVisible($h);" +
    "x=$r.Left;y=$r.Top;width=$r.Right-$r.Left;height=$r.Bottom-$r.Top});return $true}\n" +
    "[void][PrsloyMunimLiveWindows]::EnumWindows($cb,[IntPtr]::Zero)\n" +
    "$matching=@($rows.ToArray()|Where-Object{$_.visible -and ($null -eq $expectedTitle -or $_.title -ceq $expectedTitle)})\n" +
    "$visible=@($rows.ToArray()|Where-Object{$_.visible}).Count\n" +
    "[pscustomobject]@{visibleCount=$visible;matchingWindows=@($matching)}|ConvertTo-Json -Compress -Depth 4";
  const output = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true, timeout: 10_000 },
  );
  return JSON.parse(output.trim()) as WindowInventory;
}

function display2StillMatches(): boolean {
  try {
    const script = String.raw`Add-Type -AssemblyName System.Windows.Forms
$screens = @([System.Windows.Forms.Screen]::AllScreens | Where-Object { $_.DeviceName -eq '\\.\DISPLAY2' -and -not $_.Primary })
if ($screens.Count -ne 1) { exit 1 }
$bounds = $screens[0].Bounds; $work = $screens[0].WorkingArea
if ($bounds.X -ne 2560 -or $bounds.Y -ne 0 -or $bounds.Width -ne 1920 -or $bounds.Height -ne 1080 -or $work.Bottom -ne 1032) { exit 1 }`;
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
  if (!insideDisplay2(bounds)) throw new Error("Every live test window must fit inside DISPLAY2");
}

function boundsEqual(left: Bounds, right: Bounds): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

function assertChildPath(parent: string, child: string): void {
  const relative = resolve(child).slice(resolve(parent).length);
  if (!relative.startsWith(sep) || relative.includes(`..${sep}`))
    throw new Error("Temporary live test path is outside its allowed root");
}

async function assertNoWorkspaceInstructions(workspace: string, tempRoot: string): Promise<void> {
  for (const directory of [workspace, tempRoot]) {
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      try {
        await readFile(join(directory, name));
        throw new Error("Temporary live fixture workspace has inherited agent instructions");
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "Temporary live fixture workspace has inherited agent instructions"
        )
          throw error;
        if (!isMissingFile(error))
          throw new Error("Could not verify synthetic workspace instructions");
      }
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function boundedCleanup(
  operation: () => Promise<unknown>,
  timeoutMs = 5_000,
): Promise<boolean> {
  return await new Promise<boolean>((resolveWait) => {
    const timer = setTimeout(() => resolveWait(false), timeoutMs);
    void Promise.resolve()
      .then(operation)
      .then(
        () => {
          clearTimeout(timer);
          resolveWait(true);
        },
        () => {
          clearTimeout(timer);
          resolveWait(false);
        },
      );
  });
}
