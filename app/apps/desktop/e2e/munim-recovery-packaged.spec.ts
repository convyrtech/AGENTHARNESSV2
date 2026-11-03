import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
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
const marker = `PRSLOY-MUNIM-${randomUUID().replaceAll("-", "").slice(0, 16)}`;

type Bounds = { x: number; y: number; width: number; height: number };
type NativeWindow = Bounds & { hwnd: number; pid: number; title: string };
type WindowInventory = {
  totalCount: number;
  visibleCount: number;
  hiddenCount: number;
  matchedTitleCount: number;
  matchingWindows: Array<NativeWindow & { visible: boolean }>;
};
type GatewayMessage = {
  role?: string;
  content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: string;
};
type ToolCall = { id?: string; function?: { name?: string; arguments?: string } };

test("packaged PRSLOY Munim wrapper recovers uncertain actions and rejects stale tokens", async () => {
  test.skip(!packaged, "requires PRSLOY_E2E_PACKAGED pointing to a packaged Windows executable");
  test.skip(!munim, "requires PRSLOY_MUNIM_BINARY pointing to the verified real Munim executable");
  test.skip(process.platform !== "win32", "requires Windows UI Automation");
  test.setTimeout(300_000);

  assertInsideDisplay2(fixtureBounds);
  assertInsideDisplay2(appBounds);
  if (!display2StillMatches()) throw new Error("DISPLAY2 geometry changed before the test");
  const root = await mkdtemp(join(tmpdir(), "prsloy-munim-recovery-packaged-"));
  const build = join(root, "fixture-build");
  const published = join(build, "publish");
  const obj = join(build, "obj");
  const bin = join(build, "bin");
  const fixtureOutput = join(root, "result.txt");
  const userData = join(root, "electron-userData");
  const workspace = join(root, "workspace");
  const fixtureDll = join(published, "PrsloyMunimIsolatedFixture.dll");
  let fixture: ReturnType<typeof spawn> | undefined;
  let launched: Awaited<ReturnType<typeof launchZenoApp>> | undefined;
  let gateway: RecoveryMunimGateway | undefined;

  try {
    await mkdir(published, { recursive: true });
    await mkdir(userData, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(userData, "zeno-desktop.json"),
      JSON.stringify({ recentWorkspaces: [], window: appBounds }),
    );
    await writeFile(join(workspace, "README.md"), "Synthetic isolated Munim fixture workspace.\n");

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
    if (!fixturePid) throw new Error("Munim fixture did not start");
    const fixtureProcess = fixture;
    const initialFixtureWindow = await waitForExactWindow(fixturePid, fixtureTitle, fixtureBounds);
    let appPid = 0;
    let appHwnd = 0;
    gateway = await startRecoveryMunimGateway({
      fixturePid,
      validateBeforeAction: async () => {
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
      tools:
        "read,munim_list_apps,munim_get_app_state,munim_type_text,munim_click,munim_screenshot",
      modelInput: ["text", "image"],
      modelBaseUrl: gateway.baseUrl,
      modelApiKey: "local-munim-fixture-only",
      env: { PRSLOY_COMPUTER_USE: "1", PRSLOY_MUNIM_BINARY: munim!, PRSLOY_CUA_BINARY: "" },
    });

    const fixtureNow = await readExactWindow(fixturePid, fixtureTitle);
    expect(fixtureNow.hwnd).toBe(initialFixtureWindow.hwnd);
    expect(boundsEqual(fixtureNow, fixtureBounds) && insideDisplay2(fixtureNow)).toBe(true);
    appPid = await launched.app.evaluate(() => process.pid);
    if (!appPid) throw new Error("Packaged PRSLOY PID unavailable");
    const appWindow = await waitForAppWindow(launched, appPid);
    appHwnd = appWindow.hwnd;
    expect(insideDisplay2(appWindow)).toBe(true);

    const mcp = JSON.parse(await readFile(join(launched.agentDir, "mcp.json"), "utf8")) as {
      mcpServers?: Record<string, { command?: string }>;
    };
    // Keep the production allowlist path intact: the configured executable is the real Munim exe.
    expect(mcp.mcpServers?.munimComputerUse?.command).toBe(munim);
    await launched.fakeModel.stop();
    const modelPath = join(launched.agentDir, "models.json");
    const models = JSON.parse(await readFile(modelPath, "utf8")) as {
      providers: Record<
        string,
        { baseUrl: string; apiKey: string; models: Array<{ input: string[] }> }
      >;
    };
    const provider = models.providers["zeno-fake"];
    if (!provider) throw new Error("Isolated scripted model provider missing");
    expect(provider.baseUrl).toBe(gateway.baseUrl);

    await launched.page.waitForSelector('[data-testid="zeno-app"][data-bootstrap-ready="true"]', {
      timeout: 120_000,
    });
    const runtime = launched.page.getByTestId("runtime-snapshot").first();
    const currentRuntime = await runtime.textContent().catch(() => "");
    if (!/"runtimeId":\s*"([^"]+)"/u.test(currentRuntime ?? "")) {
      await launched.page.getByTestId("start-host").click({ force: true });
      await expect(runtime).toContainText("runtimeId", { timeout: 60_000 });
    }
    const trust = launched.page.getByTestId("project-trust-dialog-trust");
    if (await trust.isVisible().catch(() => false)) await trust.click();

    await sendPrompt(
      launched.page,
      `Only use the isolated fixture. Type ${marker} in its test field and return without saving yet.`,
    );
    await expect.poll(() => gateway!.firstTypeDispatched, { timeout: 120_000 }).toBe(true);
    await expect.poll(() => gateway!.firstTurnSettled, { timeout: 60_000 }).toBe(true);
    await waitSettled(launched.page);
    await acknowledgeRecovery(launched.page, "cua-recovery-accept-unknown");

    const recoveryAfterType = await launched.page.evaluate(() =>
      window.zeno.prsloy.cuaRecovery.list(),
    );
    expect(recoveryAfterType).toEqual([]);
    const oldSaveToken = gateway.firstSaveToken;
    if (!oldSaveToken) throw new Error("First Munim snapshot did not expose a save-control token");

    await sendPrompt(
      launched.page,
      "Fresh user turn: reject my old control token, then inspect and save once.",
    );
    await expect.poll(() => gateway!.secondTurnDone, { timeout: 120_000 }).toBe(true);
    await expect.poll(() => gateway!.saveDispatched, { timeout: 60_000 }).toBe(true);
    await expect.poll(() => readFile(fixtureOutput, "utf8").catch(() => "")).toBe(marker);
    await waitSettled(launched.page);
    await acknowledgeRecovery(launched.page, "cua-recovery-completed");
    expect(await launched.page.evaluate(() => window.zeno.prsloy.cuaRecovery.list())).toEqual([]);

    await sendPrompt(
      launched.page,
      "New user turn: inspect only and report the saved fixture status.",
    );
    await expect.poll(() => gateway!.finalStateVerified, { timeout: 120_000 }).toBe(true);
    await waitSettled(launched.page);

    expect(gateway.rawBypassRejected).toBe(true);
    expect(gateway.topLevelRawToolsAbsent).toBe(true);
    expect(gateway.staleOldTokenRejected).toBe(true);
    expect(gateway.screenshotImageCorrelated).toBe(true);
    expect(gateway.fixturePidSeen).toBe(true);
    expect(gateway.savedStatusSeen).toBe(true);
    expect(gateway.issuedWrapperActions).toEqual(["type_text", "click"]);
    expect(await readFile(fixtureOutput, "utf8")).toBe(marker);

    const finalFixture = await readExactWindow(fixturePid, fixtureTitle);
    const finalApp = await readAppWindow(appPid);
    expect(finalFixture.hwnd).toBe(initialFixtureWindow.hwnd);
    expect(boundsEqual(finalFixture, fixtureBounds) && insideDisplay2(finalFixture)).toBe(true);
    expect(finalApp.hwnd).toBe(appWindow.hwnd);
    expect(insideDisplay2(finalApp)).toBe(true);
    await writeFile(
      test.info().outputPath("munim-recovery-packaged-evidence.json"),
      JSON.stringify({
        backend: "verified Munim executable through production allowlist",
        model: "loopback-only scripted gateway",
        toolSequence: gateway.toolSequence,
        issuedWrapperActions: gateway.issuedWrapperActions,
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
        staleOldTokenRejected: gateway.staleOldTokenRejected,
        sameBackendElementIdsObserved:
          "unverified: wrapper intentionally hides backend eN IDs; covered by wrapper/Pi unit test",
        screenshotImageCorrelated: gateway.screenshotImageCorrelated,
        savedStatusSeen: gateway.savedStatusSeen,
        fixtureStateShape: gateway.fixtureStateShape,
        finalFixtureStateShape: gateway.finalFixtureStateShape,
        markerFileVerified: true,
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

type RecoveryMunimGateway = {
  baseUrl: string;
  toolSequence: string[];
  issuedWrapperActions: string[];
  firstTypeDispatched: boolean;
  firstTurnSettled: boolean;
  secondTurnDone: boolean;
  saveDispatched: boolean;
  finalStateVerified: boolean;
  fixturePidSeen: boolean;
  topLevelRawToolsAbsent: boolean;
  rawBypassRejected: boolean;
  staleOldTokenRejected: boolean;
  sameBackendElementIdsObserved: false;
  screenshotImageCorrelated: boolean;
  savedStatusSeen: boolean;
  fixtureStateShape: string[];
  finalFixtureStateShape: string[];
  firstSaveToken?: string;
  close(): Promise<void>;
};

async function startRecoveryMunimGateway(options: {
  fixturePid: number;
  validateBeforeAction: () => Promise<boolean>;
}): Promise<RecoveryMunimGateway> {
  const gateway: RecoveryMunimGateway = {
    baseUrl: "",
    toolSequence: [],
    issuedWrapperActions: [],
    firstTypeDispatched: false,
    firstTurnSettled: false,
    secondTurnDone: false,
    saveDispatched: false,
    finalStateVerified: false,
    fixturePidSeen: false,
    topLevelRawToolsAbsent: true,
    rawBypassRejected: false,
    staleOldTokenRejected: false,
    sameBackendElementIdsObserved: false,
    screenshotImageCorrelated: false,
    savedStatusSeen: false,
    fixtureStateShape: [],
    finalFixtureStateShape: [],
    close: async () => undefined,
  };
  let phase: "raw-probe" | "first" | "second" | "final" = "raw-probe";
  let oldSaveToken = "";
  let newSaveToken = "";
  let staleAttempted = false;
  const seenToolCallIds = new Set<string>();
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
      const messages = body.messages ?? [];
      const tools = body.tools ?? [];
      const toolMessages = messages.filter((message) => message.role === "tool");
      const lastTool = toolMessages.at(-1);
      const resultText = textOf(lastTool?.content);
      const lastCall = findLastToolCall(messages);
      const toolName = lastCall?.function?.name ?? "";
      if (lastCall?.id && !seenToolCallIds.has(lastCall.id)) {
        seenToolCallIds.add(lastCall.id);
        gateway.toolSequence.push(toolName);
      }
      const userText =
        messages
          .filter((message) => message.role === "user")
          .map((message) => textOf(message.content))
          .at(-1) ?? "";
      gateway.topLevelRawToolsAbsent = !tools.some((tool) =>
        (tool.function?.name ?? "").startsWith("mcp__munimComputerUse__"),
      );
      if (lastTool && toolName === "munim_screenshot" && lastCall?.id) {
        gateway.screenshotImageCorrelated = screenshotImageFollowsToolResult(messages, lastCall.id);
      }
      if (userText.includes("Fresh user turn:") && phase !== "second") {
        phase = "second";
        await sendCompletion(res, wrapperCall("munim_list_apps", {}), toolMessages.length);
        return;
      }
      if (userText.includes("New user turn:") && phase !== "final") {
        phase = "final";
        await sendCompletion(res, wrapperCall("munim_list_apps", {}), toolMessages.length);
        return;
      }
      if (phase === "raw-probe") {
        if (!(await options.validateBeforeAction()))
          throw new Error("DISPLAY2/PID/HWND preflight failed before raw-call denial probe");
        phase = "first";
        await sendCompletion(
          res,
          rawCall("click", { app: String(options.fixturePid), element_id: "e1" }),
          0,
        );
        return;
      }

      if (phase === "first") {
        const resultCount = toolMessages.length;
        if (resultCount <= 1 && toolName === "mcp__munimComputerUse__click") {
          gateway.rawBypassRejected =
            /not found|unknown tool|not allowed|not available|not registered|разреш|неизвест|blocked|запрещ/iu.test(
              resultText,
            );
          await sendCompletion(res, wrapperCall("munim_list_apps", {}), resultCount);
          return;
        }
        if (toolName === "munim_list_apps") {
          gateway.fixturePidSeen = fixtureHasSingleWindow(resultText, options.fixturePid);
          if (!gateway.fixturePidSeen)
            throw new Error("Munim did not report the isolated fixture as a one-window process");
          await sendCompletion(
            res,
            wrapperCall("munim_get_app_state", { pid: options.fixturePid }),
            resultCount,
          );
          return;
        }
        if (toolName === "munim_get_app_state") {
          gateway.fixtureStateShape = fixtureControlShape(resultText, marker);
          const { fieldToken, saveToken } = readFixtureTokens(resultText);
          gateway.firstSaveToken ??= saveToken;
          if (phase === "first" && !oldSaveToken) {
            oldSaveToken = saveToken;
            // Raw Munim IDs are intentionally not returned by the wrapper. Packaged proof of
            // their reuse is therefore unverified; the wrapper/Pi unit tests cover that invariant.
            if (!(await options.validateBeforeAction()))
              throw new Error("DISPLAY2/PID/HWND preflight failed before type_text");
            gateway.issuedWrapperActions.push("type_text");
            await sendCompletion(
              res,
              wrapperCall("munim_type_text", {
                pid: options.fixturePid,
                element_token: fieldToken,
                text: marker,
              }),
              resultCount,
            );
            gateway.firstTypeDispatched = true;
            return;
          }
          throw new Error("Unexpected Munim snapshot in recovery flow");
        }
        if (toolName === "munim_type_text") {
          gateway.firstTurnSettled = true;
          await sendCompletion(res, undefined, resultCount);
          return;
        }
      }
      if (phase === "second") {
        if (toolName === "munim_list_apps") {
          gateway.fixturePidSeen =
            gateway.fixturePidSeen && fixtureHasSingleWindow(resultText, options.fixturePid);
          await sendCompletion(
            res,
            wrapperCall("munim_get_app_state", { pid: options.fixturePid }),
            toolMessages.length,
          );
          return;
        }
        if (toolName === "munim_get_app_state" && !oldSaveToken)
          throw new Error("Missing prior token");
        if (toolName === "munim_get_app_state" && !staleAttempted) {
          if (!(await options.validateBeforeAction()))
            throw new Error("DISPLAY2/PID/HWND preflight failed before stale-token probe");
          await sendCompletion(
            res,
            wrapperCall("munim_click", { pid: options.fixturePid, element_token: oldSaveToken }),
            toolMessages.length,
          );
          return;
        }
        if (toolName === "munim_click" && !staleAttempted) {
          gateway.staleOldTokenRejected =
            /(?:устар|snapshot|снимок|token|токен)/iu.test(resultText) &&
            !gateway.issuedWrapperActions.includes("click");
          staleAttempted = true;
          await sendCompletion(
            res,
            wrapperCall("munim_get_app_state", { pid: options.fixturePid }),
            toolMessages.length,
          );
          return;
        }
        if (toolName === "munim_get_app_state" && staleAttempted && !newSaveToken) {
          const { saveToken } = readFixtureTokens(resultText);
          newSaveToken = saveToken;
          if (!(await options.validateBeforeAction()))
            throw new Error("DISPLAY2/PID/HWND preflight failed before save click");
          gateway.issuedWrapperActions.push("click");
          await sendCompletion(
            res,
            wrapperCall("munim_click", { pid: options.fixturePid, element_token: newSaveToken }),
            toolMessages.length,
          );
          gateway.saveDispatched = true;
          return;
        }
        if (toolName === "munim_click" && gateway.saveDispatched) {
          gateway.secondTurnDone = true;
          await sendCompletion(res, undefined, toolMessages.length);
          return;
        }
      }
      if (phase === "final") {
        if (toolName === "munim_list_apps") {
          await sendCompletion(
            res,
            wrapperCall("munim_get_app_state", { pid: options.fixturePid }),
            toolMessages.length,
          );
          return;
        }
        if (toolName === "munim_get_app_state") {
          gateway.finalFixtureStateShape = fixtureControlShape(resultText, marker);
          gateway.savedStatusSeen = resultText.includes(`Saved: ${marker}`);
          if (!gateway.savedStatusSeen)
            throw new Error("Saved status absent from post-recovery snapshot");
          gateway.finalStateVerified = true;
          if (!(await options.validateBeforeAction()))
            throw new Error("DISPLAY2/PID/HWND preflight failed before screenshot");
          await sendCompletion(
            res,
            wrapperCall("munim_screenshot", { pid: options.fixturePid }),
            toolMessages.length,
          );
          return;
        }
        if (toolName === "munim_screenshot") {
          if (!gateway.screenshotImageCorrelated)
            throw new Error("Final Munim screenshot result did not carry a correlated image");
          await sendCompletion(res, undefined, toolMessages.length);
          return;
        }
      }
      await sendCompletion(res, undefined, toolMessages.length);
    })().catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : "scripted gateway error",
        }),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock gateway bind failed");
  gateway.baseUrl = `http://127.0.0.1:${address.port}/v1`;
  gateway.close = async () => {
    server.closeAllConnections();
    server.close();
    await new Promise<void>((resolve) => server.once("close", resolve));
  };
  return gateway;
}

async function sendPrompt(page: import("playwright").Page, promptText: string): Promise<void> {
  await page.getByTestId("prompt-input").fill(promptText);
  await page.getByTestId("send-prompt").click();
}

async function acknowledgeRecovery(
  page: import("playwright").Page,
  resolution: "cua-recovery-completed" | "cua-recovery-accept-unknown",
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

async function sendCompletion(
  res: import("node:http").ServerResponse,
  call: { name: string; args: Record<string, unknown> } | undefined,
  step: number,
): Promise<void> {
  const payload = {
    id: `munim-recovery-${step}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "zeno-fake",
    choices: [
      {
        index: 0,
        message: call
          ? {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  index: 0,
                  id: `munim-recovery-call-${step}`,
                  type: "function",
                  function: { name: call.name, arguments: JSON.stringify(call.args) },
                },
              ],
            }
          : { role: "assistant", content: "The isolated fixture state was checked." },
        finish_reason: call ? "tool_calls" : "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const choice = payload.choices[0]!;
  const delta = (value: Record<string, unknown>, finish: string | null = null) =>
    res.write(
      `data: ${JSON.stringify({ id: payload.id, object: "chat.completion.chunk", created: payload.created, model: payload.model, choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`,
    );
  delta({ role: "assistant" });
  if (call) delta({ tool_calls: choice.message.tool_calls });
  else delta({ content: choice.message.content });
  delta({}, choice.finish_reason);
  res.end("data: [DONE]\n\n");
}

function wrapperCall(name: string, args: Record<string, unknown>) {
  return { name, args };
}
function rawCall(name: string, args: Record<string, unknown>) {
  return { name: `mcp__munimComputerUse__${name}`, args };
}
function findLastToolCall(messages: GatewayMessage[]): ToolCall | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant" || !Array.isArray(message.tool_calls)) continue;
    const calls = message.tool_calls as ToolCall[];
    if (calls.length) return calls.at(-1);
  }
  return undefined;
}
function fixtureControlShape(snapshot: string, marker: string): string[] {
  return snapshot
    .split(/\r?\n/u)
    .filter((line) => /Test text|Save test marker|Saved:|Ready/u.test(line))
    .map((line) =>
      line.replaceAll(marker, "<MARKER>").replace(/munim_v1\.[0-9a-f-]{36}\.\d+/gu, "<TOKEN>"),
    );
}

function fixtureHasSingleWindow(text: string, pid: number): boolean {
  const rows = text
    .split(/\r?\n/u)
    .filter((line) => new RegExp(`\\bpid=${pid}(?:[ \\t]|$)`, "u").test(line));
  return rows.length === 1 && /(?:^|[ \t])windows=1(?:[ \t]|$)/u.test(rows[0]!);
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
function screenshotImageFollowsToolResult(messages: GatewayMessage[], toolCallId: string): boolean {
  const resultIndex = messages.findIndex(
    (message) => message.role === "tool" && message.tool_call_id === toolCallId,
  );
  if (resultIndex < 0) return false;
  if (hasImagePayload(messages[resultIndex]?.content)) return true;
  return messages
    .slice(resultIndex + 1)
    .some(
      (message) =>
        message.role === "user" &&
        textOf(message.content).includes("Attached image(s) from tool result:") &&
        hasImagePayload(message.content),
    );
}
function hasImagePayload(content: unknown): boolean {
  if (!content) return false;
  if (Array.isArray(content))
    return content.some(
      (part) =>
        part &&
        typeof part === "object" &&
        ((part as { type?: unknown }).type === "image" ||
          (part as { type?: unknown }).type === "image_url" ||
          typeof (part as { image_url?: unknown }).image_url === "object"),
    );
  if (typeof content === "string") return /data:image\/|image_url/iu.test(content);
  return false;
}
function readFixtureTokens(snapshot: string): { fieldToken: string; saveToken: string } {
  const tokenFor = (label: RegExp) => {
    const matches = snapshot
      .split(/\r?\n/u)
      .filter((line) => label.test(line))
      .map((line) => line.match(/munim_v1\.[0-9a-f-]{36}\.\d+/u)?.[0])
      .filter((token): token is string => token !== undefined);
    if (matches.length !== 1)
      throw new Error("Munim snapshot did not expose one opaque fixture control token");
    return matches[0]!;
  };
  return {
    fieldToken: tokenFor(/Test text/iu),
    saveToken: tokenFor(/Save test marker/iu),
  };
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
  throw new Error(
    `Fixture window did not match the owned PID/title/bounds on DISPLAY2: ${JSON.stringify({ pid, visibleCount: last?.visibleCount, matchedTitleCount: last?.matchedTitleCount })}`,
  );
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
      const appWindow = BrowserWindow.getAllWindows()[0];
      const handle = appWindow?.getNativeWindowHandle();
      return appWindow && handle?.length
        ? { hwnd: Number(handle.readBigUInt64LE()), bounds: appWindow.getBounds() }
        : undefined;
    });
    if (
      native &&
      expected &&
      native.hwnd === expected.hwnd &&
      insideDisplay2(native) &&
      insideDisplay2(expected.bounds)
    )
      return native;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Packaged PRSLOY native PID/HWND/bounds preflight failed");
}
async function readAppWindow(pid: number): Promise<NativeWindow> {
  const inventory = await readProcessWindowInventory(pid);
  if (inventory.visibleCount !== 1 || inventory.matchingWindows.length !== 1)
    throw new Error("Packaged PRSLOY must own exactly one visible HWND");
  return inventory.matchingWindows[0]!;
}
function readProcessWindowInventory(pid: number, expectedTitle?: string): Promise<WindowInventory> {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class PrsloyMunimRecoveryWindows {
  public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
}
'@
$targetPid = [uint32]${pid}
$expectedTitle = ${expectedTitle === undefined ? "$null" : `'${expectedTitle.replaceAll("'", "''")}'`}
$rows = [System.Collections.Generic.List[object]]::new()
$callback = [PrsloyMunimRecoveryWindows+EnumWindowsProc] {
  param([IntPtr]$hwnd, [IntPtr]$unused)
  [uint32]$owner = 0
  [void][PrsloyMunimRecoveryWindows]::GetWindowThreadProcessId($hwnd, [ref]$owner)
  if ($owner -ne $targetPid) { return $true }
  $rect = [PrsloyMunimRecoveryWindows+RECT]::new()
  if (-not [PrsloyMunimRecoveryWindows]::GetWindowRect($hwnd, [ref]$rect)) { return $true }
  $text = [System.Text.StringBuilder]::new(1024)
  [void][PrsloyMunimRecoveryWindows]::GetWindowText($hwnd, $text, $text.Capacity)
  $rows.Add([pscustomobject]@{ hwnd=$hwnd.ToInt64(); pid=$owner; title=$text.ToString(); visible=[PrsloyMunimRecoveryWindows]::IsWindowVisible($hwnd); x=$rect.Left; y=$rect.Top; width=$rect.Right-$rect.Left; height=$rect.Bottom-$rect.Top })
  return $true
}
[void][PrsloyMunimRecoveryWindows]::EnumWindows($callback, [IntPtr]::Zero)
$matching = [System.Collections.Generic.List[object]]::new()
foreach ($row in $rows) { if ($row.visible -and ($null -eq $expectedTitle -or $row.title -ceq $expectedTitle)) { $matching.Add($row) } }
[pscustomobject]@{ totalCount=$rows.Count; visibleCount=@($rows.ToArray() | Where-Object { $_.visible }).Count; hiddenCount=@($rows.ToArray() | Where-Object { -not $_.visible }).Count; matchedTitleCount=@($matching.ToArray()).Count; matchingWindows=@($matching | ForEach-Object { [pscustomobject]@{ hwnd=$_.hwnd; pid=$_.pid; title=$_.title; visible=$_.visible; x=$_.x; y=$_.y; width=$_.width; height=$_.height } }) } | ConvertTo-Json -Compress -Depth 4
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
