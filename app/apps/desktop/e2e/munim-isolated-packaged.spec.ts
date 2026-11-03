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

test("packaged PRSLOY uses real Munim only on its isolated DISPLAY2 fixture", async () => {
  test.skip(!packaged, "requires PRSLOY_E2E_PACKAGED pointing to a packaged Windows executable");
  test.skip(!munim, "requires PRSLOY_MUNIM_BINARY pointing to the real Munim binary");
  test.skip(process.platform !== "win32", "requires Windows UI Automation");
  test.setTimeout(240_000);

  assertInsideDisplay2(fixtureBounds);
  assertInsideDisplay2(appBounds);
  const root = await mkdtemp(join(tmpdir(), "prsloy-munim-isolated-packaged-"));
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
  let gateway: ScriptedMunimGateway | undefined;

  try {
    await mkdir(published, { recursive: true });
    await mkdir(userData, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(userData, "zeno-desktop.json"),
      JSON.stringify({ recentWorkspaces: [], window: appBounds }),
    );
    await writeFile(
      join(workspace, "README.md"),
      "Synthetic isolated Munim test workspace. No customer data.\n",
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
    gateway = await startScriptedMunimGateway({
      fixturePid,
      fixtureTitle,
      marker,
      validateBeforeDispatch: async () => {
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
          !insideDisplay2(currentFixture)
        )
          return false;
        const currentApp = await readAppWindow(appPid).catch(() => undefined);
        return (
          currentApp !== undefined && currentApp.hwnd === appHwnd && insideDisplay2(currentApp)
        );
      },
    });

    launched = await launchZenoApp({
      root,
      workspacePath: workspace,
      tools:
        "read,mcp__munimComputerUse__list_apps,mcp__munimComputerUse__get_app_state,mcp__munimComputerUse__type_text,mcp__munimComputerUse__click,mcp__munimComputerUse__screenshot",
      modelInput: ["text", "image"],
      modelBaseUrl: gateway.baseUrl,
      modelApiKey: "local-munim-fixture-only",
      env: {
        PRSLOY_COMPUTER_USE: "1",
        PRSLOY_MUNIM_BINARY: munim!,
      },
    });

    const fixtureNow = await readExactWindow(fixturePid, fixtureTitle);
    expect(fixtureNow.hwnd).toBe(initialFixtureWindow.hwnd);
    expect(insideDisplay2(fixtureNow)).toBe(true);
    appPid = await launched.app.evaluate(() => process.pid);
    if (!appPid) throw new Error("Packaged PRSLOY PID unavailable");
    const appWindow = await waitForAppWindow(launched, appPid);
    appHwnd = appWindow.hwnd;
    expect(insideDisplay2(appWindow)).toBe(true);

    const mcp = JSON.parse(await readFile(join(launched.agentDir, "mcp.json"), "utf8")) as {
      mcpServers?: Record<string, { command?: string }>;
    };
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
    await launched.page
      .getByTestId("prompt-input")
      .fill(
        `Use only the visible isolated Munim fixture. Enter ${marker}, save it, then report the saved status.`,
      );
    await launched.page.getByTestId("send-prompt").click();
    await expect.poll(() => gateway!.toolSequence.length, { timeout: 120_000 }).toBe(7);
    await waitSettled(launched.page);

    expect(gateway.toolSequence).toEqual([
      "list_apps",
      "get_app_state",
      "type_text",
      "get_app_state",
      "click",
      "get_app_state",
      "screenshot",
    ]);
    expect(gateway.fixturePidSeen).toBe(true);
    expect(gateway.imageSeenAfterScreenshot).toBe(true);
    expect(await readFile(fixtureOutput, "utf8")).toBe(marker);
    expect(gateway.savedStatusSeen, JSON.stringify(gateway.stateChecks)).toBe(true);
    const finalFixture = await readExactWindow(fixturePid, fixtureTitle);
    expect(finalFixture.hwnd).toBe(initialFixtureWindow.hwnd);
    expect(insideDisplay2(finalFixture)).toBe(true);
    const finalApp = await readAppWindow(appPid);
    expect(finalApp.hwnd).toBe(appWindow.hwnd);
    expect(insideDisplay2(finalApp)).toBe(true);
    await writeFile(
      test.info().outputPath("munim-packaged-evidence.json"),
      JSON.stringify({
        backend: "Munim 0.9.0",
        model: "local-scripted-gateway",
        toolSequence: gateway.toolSequence,
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
        fixturePidSeen: gateway.fixturePidSeen,
        imageSeenAfterScreenshot: gateway.imageSeenAfterScreenshot,
        savedStatusSeen: gateway.savedStatusSeen,
        markerFileVerified: true,
        stateChecks: gateway.stateChecks,
      }),
    );
  } finally {
    await launched?.app.close().catch(() => undefined);
    await launched?.fakeModel.stop().catch(() => undefined);
    await gateway?.close().catch(() => undefined);
    if (fixture) {
      const exited = once(fixture, "exit").catch(() => undefined);
      if (fixture.exitCode === null && fixture.signalCode === null) fixture.kill();
      if (fixture.exitCode === null && fixture.signalCode === null) {
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
      }
    }
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

type ScriptedMunimGateway = {
  baseUrl: string;
  toolSequence: string[];
  fixturePidSeen: boolean;
  imageSeenAfterScreenshot: boolean;
  savedStatusSeen: boolean;
  stateChecks: Array<{ step: number; markerSeen: boolean; savedSeen: boolean }>;
  close(): Promise<void>;
};

async function startScriptedMunimGateway(options: {
  fixturePid: number;
  fixtureTitle: string;
  marker: string;
  validateBeforeDispatch: () => Promise<boolean>;
}): Promise<ScriptedMunimGateway> {
  const gateway: ScriptedMunimGateway = {
    baseUrl: "",
    toolSequence: [],
    fixturePidSeen: false,
    imageSeenAfterScreenshot: false,
    savedStatusSeen: false,
    stateChecks: [],
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
      const body = JSON.parse(raw) as { messages?: GatewayMessage[] };
      const messages = body.messages ?? [];
      const toolMessages = messages.filter((message) => message.role === "tool");
      const currentToolResult = toolMessages.at(-1)?.content;
      const resultText = textOf(currentToolResult);
      const allText = messages.map((message) => textOf(message.content)).join("\n");

      if (screenshotImageFollowsOwnToolResult(messages)) gateway.imageSeenAfterScreenshot = true;
      if (allText.includes(`Saved: ${options.marker}`)) gateway.savedStatusSeen = true;

      const step = toolMessages.length;
      if ([2, 4, 6].includes(step)) {
        gateway.stateChecks.push({
          step,
          markerSeen: resultText.includes(options.marker),
          savedSeen: resultText.includes(`Saved: ${options.marker}`),
        });
      }
      let next: { name: string; args: Record<string, unknown> } | undefined;
      if (step === 0) next = { name: "list_apps", args: {} };
      else if (step === 1) {
        const row = resultText
          .split(/\r?\n/u)
          .find((line) => new RegExp(`pid=${options.fixturePid}(?:\\s|$)`, "u").test(line));
        gateway.fixturePidSeen = row !== undefined;
        if (!row || !/(?:^|\s)windows=1(?:\s|$)/u.test(row))
          throw new Error("Munim did not report the single isolated fixture process");
        next = { name: "get_app_state", args: { app: String(options.fixturePid) } };
      } else if (step === 2) {
        verifyFixtureState(resultText, options.fixturePid);
        next = {
          name: "type_text",
          args: { element_id: elementIdFor(resultText, /Test text/iu), text: options.marker },
        };
      } else if (step === 3)
        next = { name: "get_app_state", args: { app: String(options.fixturePid) } };
      else if (step === 4) {
        verifyFixtureState(resultText, options.fixturePid);
        next = {
          name: "click",
          args: { element_id: elementIdFor(resultText, /Save test marker/iu) },
        };
      } else if (step === 5)
        next = { name: "get_app_state", args: { app: String(options.fixturePid) } };
      else if (step === 6) next = { name: "screenshot", args: { app: String(options.fixturePid) } };

      if (next && !(await options.validateBeforeDispatch())) {
        res.writeHead(409, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "isolated fixture target changed; dispatch blocked" }));
        return;
      }
      if (next) gateway.toolSequence.push(next.name);
      const response = await jsonCompletion(next, step);
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      const row = response as {
        id: string;
        object: string;
        created: number;
        model: string;
        choices: Array<{ index: number; message: Record<string, unknown>; finish_reason: string }>;
        usage: Record<string, number>;
      };
      const choice = row.choices[0]!;
      const message = choice.message;
      const send = (
        delta: Record<string, unknown>,
        finish: string | null = null,
        usage?: Record<string, number>,
      ) => {
        res.write(
          `data: ${JSON.stringify({ id: row.id, object: "chat.completion.chunk", created: row.created, model: row.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`,
        );
      };
      send({ role: "assistant" });
      if (Array.isArray(message.tool_calls)) {
        send({ tool_calls: message.tool_calls });
      } else if (typeof message.content === "string") {
        send({ content: message.content });
      }
      send({}, choice.finish_reason, row.usage);
      res.end("data: [DONE]\n\n");
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
  if (!address || typeof address === "string") throw new Error("scripted gateway bind failed");
  gateway.baseUrl = `http://127.0.0.1:${address.port}/v1`;
  gateway.close = async () => {
    server.closeAllConnections();
    server.close();
    await new Promise<void>((resolve) => server.once("close", resolve));
  };
  return gateway;
}

async function jsonCompletion(
  tool: { name: string; args: Record<string, unknown> } | undefined,
  step: number,
): Promise<Record<string, unknown>> {
  return {
    id: `munim-isolated-${step}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "zeno-fake",
    choices: [
      {
        index: 0,
        message: tool
          ? {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  index: 0,
                  id: `munim-call-${step}`,
                  type: "function",
                  function: {
                    name: `mcp__munimComputerUse__${tool.name}`,
                    arguments: JSON.stringify(tool.args),
                  },
                },
              ],
            }
          : { role: "assistant", content: "Fixture saved and verified." },
        finish_reason: tool ? "tool_calls" : "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
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
    ) {
      return window;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const details = last
    ? {
        pid,
        totalCount: last.totalCount,
        visibleCount: last.visibleCount,
        hiddenCount: last.hiddenCount,
        matchedTitleCount: last.matchedTitleCount,
        fixtureWindow: last.matchingWindows.map(
          ({ hwnd, pid: windowPid, title: _title, visible, ...rect }) => ({
            hwnd,
            pid: windowPid,
            visible,
            rect,
          }),
        ),
        expectedBounds: expected,
      }
    : { pid, inventoryUnavailable: true };
  throw new Error(
    `Munim fixture did not produce exactly one expected HWND on DISPLAY2: ${JSON.stringify(details)}`,
  );
}

async function readExactWindow(pid: number, title: string): Promise<NativeWindow> {
  const inventory = await readProcessWindowInventory(pid, title);
  const window = inventory.matchingWindows[0];
  if (inventory.visibleCount !== 1 || inventory.matchingWindows.length !== 1 || !window)
    throw new Error("Munim fixture no longer has exactly one expected HWND");
  return window;
}

async function waitForAppWindow(
  launched: Awaited<ReturnType<typeof launchZenoApp>>,
  pid: number,
): Promise<NativeWindow> {
  let last: WindowInventory | undefined;
  let lastExpected: { bounds: Bounds; hwnd: number } | undefined;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    last = await readProcessWindowInventory(pid).catch(() => undefined);
    const window = last?.visibleCount === 1 ? last.matchingWindows[0] : undefined;
    const expected = await launched.app.evaluate(({ BrowserWindow }) => {
      const appWindow = BrowserWindow.getAllWindows()[0];
      const handle = appWindow?.getNativeWindowHandle();
      return appWindow && handle?.length
        ? { bounds: appWindow.getBounds(), hwnd: Number(handle.readBigUInt64LE()) }
        : undefined;
    });
    lastExpected = expected;
    if (
      window &&
      expected &&
      window.hwnd === expected.hwnd &&
      insideDisplay2(window) &&
      insideDisplay2(expected.bounds)
    )
      return window;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Packaged PRSLOY window preflight failed: ${JSON.stringify({
      totalCount: last?.totalCount,
      visibleCount: last?.visibleCount,
      hiddenCount: last?.hiddenCount,
      native: last?.matchingWindows.map(({ hwnd, x, y, width, height }) => ({
        hwnd,
        x,
        y,
        width,
        height,
      })),
      expected: lastExpected,
    })}`,
  );
}

async function readAppWindow(pid: number): Promise<NativeWindow> {
  const inventory = await readProcessWindowInventory(pid);
  if (inventory.visibleCount !== 1 || inventory.matchingWindows.length !== 1)
    throw new Error("Packaged PRSLOY must own exactly one top-level window");
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
public static class PrsloyNativeWindows {
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
$callback = [PrsloyNativeWindows+EnumWindowsProc] {
  param([IntPtr]$hwnd, [IntPtr]$unused)
  [uint32]$owner = 0
  [void][PrsloyNativeWindows]::GetWindowThreadProcessId($hwnd, [ref]$owner)
  if ($owner -ne $targetPid) { return $true }
  $rect = [PrsloyNativeWindows+RECT]::new()
  if (-not [PrsloyNativeWindows]::GetWindowRect($hwnd, [ref]$rect)) { return $true }
  $text = [System.Text.StringBuilder]::new(1024)
  [void][PrsloyNativeWindows]::GetWindowText($hwnd, $text, $text.Capacity)
  $rows.Add([pscustomobject]@{ hwnd=$hwnd.ToInt64(); pid=$owner; title=$text.ToString(); visible=[PrsloyNativeWindows]::IsWindowVisible($hwnd); x=$rect.Left; y=$rect.Top; width=$rect.Right-$rect.Left; height=$rect.Bottom-$rect.Top })
  return $true
}
[void][PrsloyNativeWindows]::EnumWindows($callback, [IntPtr]::Zero)
$matching = [System.Collections.Generic.List[object]]::new()
foreach ($row in $rows) {
  if ($row.visible -and ($null -eq $expectedTitle -or $row.title -ceq $expectedTitle)) { $matching.Add($row) }
}
[pscustomobject]@{
  totalCount = $rows.Count
  visibleCount = @($rows.ToArray() | Where-Object { $_.visible }).Count
  hiddenCount = @($rows.ToArray() | Where-Object { -not $_.visible }).Count
  matchedTitleCount = @($matching.ToArray()).Count
  matchingWindows = @($matching | ForEach-Object { [pscustomobject]@{ hwnd=$_.hwnd; pid=$_.pid; title=$_.title; visible=$_.visible; x=$_.x; y=$_.y; width=$_.width; height=$_.height } })
} | ConvertTo-Json -Compress -Depth 4
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

function elementIdFor(snapshot: string, label: RegExp): string {
  const matches = snapshot
    .split(/\r?\n/u)
    .filter((line) => label.test(line))
    .map((line) => line.match(/\be\d+\b/u)?.[0])
    .filter((value): value is string => value !== undefined);
  if (matches.length !== 1)
    throw new Error("Munim snapshot did not identify one expected fixture control");
  return matches[0]!;
}

function verifyFixtureState(snapshot: string, pid: number): void {
  if (!new RegExp(`^\\s*${pid}\\s*\\(pid\\s+${pid}\\)`, "iu").test(snapshot))
    throw new Error("Munim state is not for the isolated fixture PID");
  const input = elementIdFor(snapshot, /Test text/iu);
  const save = elementIdFor(snapshot, /Save test marker/iu);
  if (input === save) throw new Error("Munim returned ambiguous fixture controls");
}

function hasImageUrl(message: GatewayMessage): boolean {
  return JSON.stringify(message.content ?? "").includes('"image_url"');
}

function screenshotImageFollowsOwnToolResult(messages: GatewayMessage[]): boolean {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) continue;
    for (const value of message.tool_calls) {
      if (!value || typeof value !== "object") continue;
      const call = value as { id?: unknown; function?: { name?: unknown } };
      if (
        typeof call.id !== "string" ||
        typeof call.function?.name !== "string" ||
        !call.function.name.endsWith("__screenshot")
      )
        continue;
      const resultIndex = messages.findIndex(
        (candidate, candidateIndex) =>
          candidateIndex > index && candidate.role === "tool" && candidate.tool_call_id === call.id,
      );
      if (resultIndex < 0) continue;
      const imageMessage = messages
        .slice(resultIndex + 1)
        .find((candidate) => candidate.role === "user");
      if (
        imageMessage &&
        textOf(imageMessage.content).includes("Attached image(s) from tool result:") &&
        hasImageUrl(imageMessage)
      )
        return true;
    }
  }
  return false;
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
  if (!insideDisplay2(bounds)) throw new Error("Test window must fit entirely inside DISPLAY2");
}

function boundsEqual(left: Bounds, right: Bounds): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}
