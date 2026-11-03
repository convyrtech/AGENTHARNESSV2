import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, launchZenoApp, test, waitSettled } from "./fixtures.ts";
import { startLiveCuaProxy } from "./live-cua-proxy.ts";

const packaged = process.env.PRSLOY_E2E_PACKAGED?.trim();
const cuaBinary = process.env.PRSLOY_CUA_BINARY?.trim();
const encryptedKey = process.env.PRSLOY_E2E_GATEWAY_ENCRYPTED_KEY?.trim();
const project = new URL("./cua-fixture/CuaFixture.csproj", import.meta.url);
const fixtureTitle = "PRSLOY 104 Packaged Cua Fixture";
const model = "gpt-6.1-sol";
const appBounds = { x: 2580, y: 500, width: 1000, height: 500 };
const fixtureBounds = { x: 2640, y: 80, width: 560, height: 340 };
const upstreamUrl = "https://api.prsloy.online/v1/chat/completions";

type Bounds = { x: number; y: number; width: number; height: number };

/**
 * Deliberately opt-in live test. The encrypted key and its synthetic Electron
 * Local State are copied into a private temporary profile; neither is logged.
 * This test is prepared for manual review and must not run as part of normal CI.
 */
test("packaged PRSLOY uses real GPT and CUA only on the isolated fixture", async () => {
  test.skip(process.env.PRSLOY_E2E_LIVE_GATEWAY !== "1", "requires explicit paid gateway opt-in");
  test.skip(process.platform !== "win32", "requires Windows UI Automation");
  test.skip(!packaged, "requires PRSLOY_E2E_PACKAGED to point to the packaged Windows app");
  test.skip(!cuaBinary, "requires PRSLOY_CUA_BINARY to point to the verified CUA driver");
  test.skip(!encryptedKey, "requires the locally entered encrypted test key");
  test.skip(
    Boolean(process.env.PRSLOY_E2E_SESSIONS?.trim()),
    "session export must stay disabled for the live fixture",
  );
  test.setTimeout(1_260_000);

  const publicRoot = resolve("C:\\Users\\Public\\Documents");
  const tempRoot = resolve(tmpdir());
  const workspace = await mkdtemp(join(publicRoot, "prsloy-live-workspace-"));
  const root = await mkdtemp(join(tempRoot, "prsloy-live-cua-profile-"));

  const fixtureOutput = join(root, "fixture-result.txt");
  const fixtureBuild = join(root, "fixture-build");
  const published = join(fixtureBuild, "publish");
  const obj = join(fixtureBuild, "obj");
  const bin = join(fixtureBuild, "bin");
  const userData = join(root, "electron-userData");
  const stateDir = join(userData, "prsloy");
  const marker = `PRSLOY-LIVE-CUA-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const syntheticPrompt = [
    "Use only the packaged CUA fixture described below. This is a synthetic test; do not use other tools or windows.",
    "The exact fixture process PID is <FIXTURE_PID> and its exact HWND is <FIXTURE_HWND>.",
    "First call cua_list_windows with the exact fixture PID.",
    `The exact window title is "${fixtureTitle}". Find only that PID and HWND, read a fresh snapshot, type exactly "${marker}" into the "Test text" field, read a fresh snapshot to verify it, click only "Save test marker", then read a fresh snapshot and report whether it shows the saved marker.`,
    "Do not click any other control. Never interact with another window, application, process, file, site, account, or network destination.",
  ].join("\n");

  let fixture: ReturnType<typeof spawn> | undefined;
  let launched: Awaited<ReturnType<typeof launchZenoApp>> | undefined;
  let proxy: Awaited<ReturnType<typeof startLiveCuaProxy>> | undefined;
  let completed = false;
  try {
    assertChildPath(publicRoot, workspace);
    assertChildPath(tempRoot, root);
    await assertNoWorkspaceInstructions(workspace, publicRoot);
    // The prompt is made only after we know both native identifiers; use a
    // replaced string so the proxy and the UI receive the exact same text.
    await mkdir(stateDir, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await mkdir(published, { recursive: true });
    const userAgentDir = join(root, "home", ".pi", "agent");
    await mkdir(userAgentDir, { recursive: true });
    await writeFile(
      join(userAgentDir, "settings.json"),
      JSON.stringify({ extensions: ["+builtin:mcp"] }),
    );
    await writeFile(
      join(workspace, "README.md"),
      "Synthetic PRSLOY CUA integration fixture. No real customer data.\n",
    );
    await writeFile(
      join(userData, "zeno-desktop.json"),
      JSON.stringify({ recentWorkspaces: [], window: appBounds }),
    );

    // Resolve the helper directory only to copy its encrypted blob and the
    // matching synthetic Local State; never decrypt or print either value.
    const keyPath = resolve(encryptedKey!);
    const localStatePath = join(dirname(keyPath), "electron-userdata", "Local State");
    try {
      await copyFile(keyPath, join(stateDir, "gateway-key.bin"));
      await copyFile(localStatePath, join(userData, "Local State"));
    } catch {
      throw new Error("Could not stage the isolated encrypted gateway credential");
    }

    execFileSync(
      "dotnet",
      [
        "publish",
        fileURLToPath(project),
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
    const fixtureDll = join(published, "PrsloyCuaFixture.dll");
    fixture = spawn(
      "dotnet",
      [fixtureDll, fixtureOutput, String(fixtureBounds.x), String(fixtureBounds.y)],
      {
        stdio: "ignore",
        windowsHide: true,
      },
    );
    const fixturePid = fixture.pid;
    if (!fixturePid) throw new Error("Isolated fixture process failed to start");
    await waitForFixtureProcess(fixturePid, fixtureTitle);
    const fixtureHwnd = readMainWindowHandle(fixturePid);
    const fixtureInfo = readExactWindowInfo(fixtureHwnd);
    if (fixtureInfo.pid !== fixturePid || !insideDisplay2(fixtureInfo.bounds)) {
      throw new Error("Fixture PID/HWND or DISPLAY2 bounds did not match the isolated fixture");
    }

    const finalPrompt = syntheticPrompt
      .replace("<FIXTURE_PID>", String(fixturePid))
      .replace("<FIXTURE_HWND>", String(fixtureHwnd));
    proxy = await startLiveCuaProxy({
      fixturePid,
      fixtureHwnd,
      fixtureTitle,
      validateFixtureTarget: () => {
        if (
          !fixture ||
          fixture.exitCode !== null ||
          fixture.signalCode !== null ||
          fixture.pid !== fixturePid
        )
          return false;
        try {
          const current = readExactWindowInfo(fixtureHwnd);
          return current.pid === fixturePid && insideDisplay2(current.bounds);
        } catch {
          return false;
        }
      },
      syntheticPrompt: finalPrompt,
      syntheticMarker: marker,
      fixtureTextValues: [marker, `Saved: ${marker}`],
      allowedModel: model,
      upstreamUrl,
      liveEnabled: true,
      maxRequests: 12,
      maxOutputTokens: 512,
      maxTotalOutboundBytes: 300_000,
      maxImageUploads: 0,
      timeoutMs: 90_000,
    });

    await writeFile(
      join(stateDir, "state.json"),
      JSON.stringify({
        baseUrl: proxy.baseUrl,
        models: { ids: [model], checkedAt: new Date().toISOString() },
      }),
    );
    await launchWorkspaceChecks(workspace, root, appBounds, fixtureInfo.bounds);

    launched = await launchZenoApp({
      root,
      workspacePath: workspace,
      tools: "cua_list_windows,cua_get_window_state,cua_type_text,cua_click",
      model: { provider: "prsloy", id: model },
      env: {
        PRSLOY_COMPUTER_USE: "1",
        PRSLOY_CUA_BINARY: cuaBinary!,
        PRSLOY_BALANCE_WARN_RUB: "0",
        ZENO_NO_AUTO_RESUME: "1",
      },
    });

    const modelPath = join(launched.agentDir, "models.json");
    const registry = JSON.parse(await readFile(modelPath, "utf8")) as {
      providers?: Record<
        string,
        { baseUrl?: string; models?: Array<{ id?: string; maxTokens?: number }> }
      >;
    };
    const modelEntry = registry.providers?.prsloy?.models?.find((entry) => entry.id === model);
    if (!modelEntry) throw new Error("Isolated test profile did not configure the selected model");
    expect(registry.providers?.prsloy?.baseUrl).toBe(proxy.baseUrl);
    modelEntry.maxTokens = 512;
    await writeFile(modelPath, JSON.stringify(registry));

    const appBoundsNow = await launched.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.getBounds(),
    );
    if (!appBoundsNow || !insideDisplay2(appBoundsNow)) {
      throw new Error("Packaged PRSLOY window is not fully inside DISPLAY2");
    }
    const fixtureNow = readExactWindowInfo(fixtureHwnd);
    if (fixtureNow.pid !== fixturePid || !insideDisplay2(fixtureNow.bounds)) {
      throw new Error("Fixture moved or changed PID before the live request");
    }

    const keyState = await launched.app.evaluate(({ app, safeStorage }) => {
      const fs = process.getBuiltinModule("node:fs")!;
      const path = process.getBuiltinModule("node:path")!;
      const keyFile = path.join(app.getPath("userData"), "prsloy", "gateway-key.bin");
      let decrypts = false;
      try {
        decrypts =
          fs.existsSync(keyFile) &&
          safeStorage.isEncryptionAvailable() &&
          safeStorage.decryptString(fs.readFileSync(keyFile)).trim().length > 0;
      } catch {
        decrypts = false;
      }
      return {
        present: fs.existsSync(keyFile),
        available: safeStorage.isEncryptionAvailable(),
        decrypts,
      };
    });
    expect(keyState).toEqual({ present: true, available: true, decrypts: true });

    await launched.fakeModel.stop();
    await launched.page.waitForSelector('[data-testid="zeno-app"][data-bootstrap-ready="true"]', {
      timeout: 120_000,
    });
    const runtime = launched.page.getByTestId("runtime-snapshot").first();
    const currentRuntime = await runtime.textContent().catch(() => "");
    if (!/"runtimeId":\s*"([^"]+)"/u.test(currentRuntime ?? "")) {
      await launched.page.getByTestId("start-host").click({ force: true });
      await expect(runtime).toContainText("runtimeId", { timeout: 60_000 });
    }
    await expect(launched.page.getByTestId("host-status").first()).toContainText(
      /Agent Host ready|Agent Host restarted|Agent settled|就绪/u,
      { timeout: 45_000 },
    );
    const trust = launched.page.getByTestId("project-trust-dialog-trust");
    if (await trust.isVisible().catch(() => false)) await trust.click();
    await launched.page.getByTestId("prompt-input").fill(finalPrompt);
    await launched.page.getByTestId("send-prompt").click();

    const checkedEvidence = () => {
      const evidence = proxy!.evidence();
      const relevantReject = evidence.contextRejects.find((reason) => reason !== "model_mismatch");
      if (relevantReject) throw new Error(`Proxy rejected context: ${relevantReject}`);
      if (evidence.blockedActions.length) {
        const blocked = evidence.blockedActions[0]!;
        throw new Error(
          `Proxy blocked call: ${blocked.reason} ${blocked.detail ?? ""} ${blocked.sseField ?? ""}`,
        );
      }
      return evidence;
    };
    await expect
      .poll(() => checkedEvidence().toolNames.includes("cua_list_windows"), { timeout: 120_000 })
      .toBe(true);
    await expect
      .poll(() => checkedEvidence().toolNames.includes("cua_type_text"), { timeout: 180_000 })
      .toBe(true);
    await expect
      .poll(() => countTool(checkedEvidence().toolNames, "cua_get_window_state"), {
        timeout: 180_000,
      })
      .toBeGreaterThanOrEqual(2);
    expect(await launched.page.evaluate(() => window.zeno.prsloy.cuaRecovery.list())).toEqual([]);
    await expect.poll(() => checkedEvidence().markerReadBack, { timeout: 180_000 }).toBe(true);

    await expect
      .poll(() => checkedEvidence().toolNames.includes("cua_click"), { timeout: 180_000 })
      .toBe(true);
    await expect
      .poll(
        () =>
          readFile(fixtureOutput, "utf8")
            .then((value) => value === marker)
            .catch(() => false),
        { timeout: 15_000 },
      )
      .toBe(true);
    await acknowledgeRecovery(launched.page, "cua-recovery-completed");
    await waitSettled(launched.page);

    const finalText = await launched.page.getByTestId("markdown-content").last().innerText();
    const evidence = proxy.evidence();
    expect(await readFile(fixtureOutput, "utf8")).toBe(marker);
    expect(evidence.requestCount).toBeGreaterThan(0);
    expect(evidence.requestCount).toBeLessThanOrEqual(12);
    expect(evidence.toolNames).toContain("cua_list_windows");
    expect(evidence.toolNames).toContain("cua_get_window_state");
    expect(evidence.toolNames).toContain("cua_type_text");
    expect(evidence.toolNames).toContain("cua_click");
    expect(evidence.imageForwarded).toBe(0);
    expect(evidence.outboundBytes).toBeLessThanOrEqual(300_000);
    expect(evidence.usage.completion_tokens).toBeLessThanOrEqual(12 * 512);
    expect(finalText).toContain(marker);
    expect(finalText).toMatch(/saved|сохран/iu);
    // Keep only aggregate, non-sensitive evidence in Playwright reports.
    await writeFile(
      test.info().outputPath("live-cua-evidence.json"),
      JSON.stringify({
        model,
        requests: evidence.requestCount,
        tools: evidence.toolNames,
        usage: evidence.usage,
        imageForwarded: evidence.imageForwarded,
        outboundBytes: evidence.outboundBytes,
        fixturePid,
        fixtureHwnd,
        display2: true,
        markerVerified: true,
      }),
    );
    completed = true;
  } finally {
    // Diagnostics contain aggregate counters and fixed rejection codes only. A
    // failed report write must never prevent removal of the isolated key copies.
    if (proxy) {
      const diagnostics = proxy.evidence();
      await writeFile(
        test.info().outputPath("live-cua-diagnostics.json"),
        JSON.stringify({
          completed,
          requestCount: diagnostics.requestCount,
          toolNames: diagnostics.toolNames,
          usage: diagnostics.usage,
          imageForwarded: diagnostics.imageForwarded,
          outboundBytes: diagnostics.outboundBytes,
          contextRejects: diagnostics.contextRejects,
          modelRejects: diagnostics.modelRejects,
          blockedActions: diagnostics.blockedActions,
        }),
      ).catch(() => undefined);
    }
    await launched?.app.close().catch(() => undefined);
    await launched?.fakeModel.stop().catch(() => undefined);
    await proxy?.close().catch(() => undefined);
    if (fixture && !fixture.killed) fixture.kill();
    // The isolated credential copies must not survive a failed directory cleanup.
    await rm(join(stateDir, "gateway-key.bin"), { force: true });
    await rm(join(userData, "Local State"), { force: true });
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function acknowledgeRecovery(
  page: import("playwright").Page,
  resolution: "cua-recovery-completed",
): Promise<void> {
  const review = page.getByRole("button", { name: /Проверить действие Cua|Review Cua action/u });
  await expect(review).toBeVisible({ timeout: 90_000 });
  await review.click();
  const dialog = page.getByTestId("cua-recovery-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("cua-recovery-acknowledge")).toBeEnabled({ timeout: 30_000 });
  await page.getByTestId("cua-recovery-acknowledge").check();
  await page.getByTestId(resolution).click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
}

async function waitForFixtureProcess(pid: number, title: string): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const mainTitle = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Get-Process -Id ${pid} -ErrorAction Stop | Select-Object -ExpandProperty MainWindowTitle`,
      ],
      { encoding: "utf8", windowsHide: true },
    ).trim();
    if (mainTitle === title) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error("Isolated CUA fixture window did not appear");
}

function readMainWindowHandle(pid: number): number {
  const result = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `(Get-Process -Id ${pid} -ErrorAction Stop).MainWindowHandle.ToInt64()`,
    ],
    { encoding: "utf8", windowsHide: true },
  ).trim();
  const hwnd = Number(result);
  if (!Number.isSafeInteger(hwnd) || hwnd <= 0) throw new Error("Fixture HWND was unavailable");
  return hwnd;
}

function readExactWindowInfo(hwnd: number): { pid: number; bounds: Bounds } {
  const source = `$source = @'
using System;
using System.Runtime.InteropServices;
public static class PrsloyLiveWindowBounds {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll", SetLastError = true)] private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll", SetLastError = true)] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  public static int[] Read(long handle) {
    uint pid; RECT rect;
    if (GetWindowThreadProcessId(new IntPtr(handle), out pid) == 0 || !GetWindowRect(new IntPtr(handle), out rect)) throw new InvalidOperationException("Native fixture bounds unavailable");
    return new int[] { (int)pid, rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top };
  }
}
'@
Add-Type -TypeDefinition $source -ErrorAction Stop
[PrsloyLiveWindowBounds]::Read(${hwnd}) | ConvertTo-Json -Compress`;
  const output = execFileSync("powershell.exe", ["-NoProfile", "-Command", source], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  const parsed = JSON.parse(output) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== 5 || !parsed.every(Number.isFinite)) {
    throw new Error("Native fixture bounds query returned invalid data");
  }
  const [pid, x, y, width, height] = parsed as [number, number, number, number, number];
  return { pid, bounds: { x, y, width, height } };
}

function insideDisplay2(bounds: Bounds): boolean {
  return (
    bounds.x >= 2560 &&
    bounds.y >= 0 &&
    bounds.x + bounds.width <= 4480 &&
    bounds.y + bounds.height <= 1032
  );
}

function countTool(toolNames: string[], name: string): number {
  return toolNames.filter((toolName) => toolName === name).length;
}

async function launchWorkspaceChecks(
  workspace: string,
  root: string,
  app: Bounds,
  fixture: Bounds,
): Promise<void> {
  const publicRoot = resolve("C:\\Users\\Public\\Documents");
  assertChildPath(publicRoot, workspace);
  assertChildPath(resolve(tmpdir()), root);
  if (!insideDisplay2(app) || !insideDisplay2(fixture))
    throw new Error("Prepared windows do not fit DISPLAY2");
}

function assertChildPath(parent: string, child: string): void {
  const rel = resolve(child).slice(resolve(parent).length);
  if (!rel.startsWith(sep) || rel.includes(`..${sep}`)) throw new Error("Unsafe temporary path");
}

async function assertNoWorkspaceInstructions(workspace: string, publicRoot: string): Promise<void> {
  for (const directory of [workspace, publicRoot]) {
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      try {
        await readFile(join(directory, name));
        throw new Error("Live CUA workspace contains inherited agent instructions");
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "Live CUA workspace contains inherited agent instructions"
        )
          throw error;
        if (!isMissingFile(error))
          throw new Error("Could not verify the synthetic workspace instruction files");
      }
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
