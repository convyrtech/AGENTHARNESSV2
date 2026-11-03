import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { createServer, type Server } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, launchZenoApp, test } from "./fixtures.ts";

const packaged = process.env.PRSLOY_E2E_PACKAGED?.trim();
const cuaBinary = process.env.PRSLOY_CUA_BINARY?.trim();
const fixtureProject = fileURLToPath(
  new URL("./cua-concurrent-fixture/CuaConcurrentFixture.csproj", import.meta.url),
);
const promptA =
  "PRSLOY_CONCURRENT_HOST_A: inspect only Host A fixture and start its delayed action once.";
const promptB =
  "PRSLOY_CONCURRENT_HOST_B: read only Host B fixture twice, then attempt its save action once.";
const titleA = "PRSLOY 104 Concurrent Cua Host A";
const titleB = "PRSLOY 104 Concurrent Cua Host B";
const appBounds = { x: 2580, y: 500, width: 1000, height: 500 };
const fixtureBoundsA = { x: 2640, y: 80, width: 540, height: 300 };
const fixtureBoundsB = { x: 3240, y: 80, width: 540, height: 300 };

type Message = { role?: string; content?: unknown };
type WindowRow = { pid: number; window_id: number; title: string };
type Snapshot = { snapshot_id?: string; elements?: Record<string, unknown>[]; markdown?: string };
type HostIdentity = { pid: number; creationTime: number };

test("packaged CUA recovery gate blocks a second real Agent Host while reads stay available", async () => {
  test.skip(!packaged, "requires PRSLOY_E2E_PACKAGED to point to the Windows packaged executable");
  test.skip(process.platform !== "win32", "requires native Windows UI Automation");
  test.skip(!cuaBinary, "set PRSLOY_CUA_BINARY to the verified portable Cua driver");
  test.setTimeout(210_000);

  const root = await mkdtemp(join(tmpdir(), "prsloy-cua-concurrent-packaged-"));
  const build = join(tmpdir(), `prsloy-cua-concurrent-fixture-${process.pid}-${Date.now()}`);
  const published = join(build, "publish");
  const obj = join(build, "obj");
  const bin = join(build, "bin");
  const outputA = join(root, "a-effect.txt");
  const outputB = join(root, "b-effect.txt");
  const startA = join(root, "a-write-ahead.txt");
  const fixturePids: number[] = [];
  const fixtureProcesses: ReturnType<typeof spawn>[] = [];
  const fixtureBoundsByPid = new Map<number, typeof fixtureBoundsA>();
  const hostIdentities = new Map<number, number>();
  let lingeringHosts: Array<[number, number]> = [];
  let launched: Awaited<ReturnType<typeof launchZenoApp>> | undefined;
  let gateway: ConcurrentGateway | undefined;
  const evidencePath = test.info().outputPath("cua-concurrent-packaged-evidence.json");

  try {
    expect([appBounds, fixtureBoundsA, fixtureBoundsB].every(insideDisplay2)).toBe(true);
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
      { stdio: "pipe" },
    );
    const fixtureDll = join(published, "CuaConcurrentFixture.dll");
    for (const fixture of [
      { title: titleA, output: outputA, marker: startA, bounds: fixtureBoundsA },
      {
        title: titleB,
        output: outputB,
        marker: join(root, "b-write-ahead.txt"),
        bounds: fixtureBoundsB,
      },
    ]) {
      const process = spawn(
        "dotnet",
        [
          fixtureDll,
          fixture.title,
          fixture.output,
          fixture.marker,
          String(fixture.bounds.x),
          String(fixture.bounds.y),
        ],
        { stdio: "ignore", windowsHide: true },
      );
      if (!process.pid) throw new Error(`fixture ${fixture.title} did not receive a process id`);
      fixtureProcesses.push(process);
      fixturePids.push(process.pid);
      fixtureBoundsByPid.set(process.pid, fixture.bounds);
      await waitForFixtureWindow(process.pid, fixture.title);
    }

    gateway = await startGateway(fixturePids[0]!, fixturePids[1]!, outputA, outputB);
    launched = await launchZenoApp({
      root,
      tools: "read,cua_list_windows,cua_get_window_state,cua_click",
      modelBaseUrl: gateway.baseUrl,
      modelApiKey: "concurrent-packaged-e2e-only",
      modelInput: ["text", "image"],
      env: { PRSLOY_COMPUTER_USE: "1", PRSLOY_CUA_BINARY: cuaBinary! },
    });

    const appHwnd = await launched.app.evaluate(({ BrowserWindow }) => {
      const handle = BrowserWindow.getAllWindows()[0]?.getNativeWindowHandle();
      return handle?.length ? Number(handle.readBigUInt64LE()) : 0;
    });
    expect(appHwnd, "packaged Electron HWND").toBeGreaterThan(0);
    const appWindow = readExactWindowInfo(appHwnd);
    const electronPids = await launched.app.evaluate(({ app }) =>
      app.getAppMetrics().map((metric) => metric.pid),
    );
    expect(
      electronPids,
      "app HWND must belong to a process owned by this packaged Electron app",
    ).toContain(appWindow.pid);
    expect(
      nearBounds(appWindow.bounds, appBounds),
      "packaged app HWND must match its DISPLAY2 placement",
    ).toBe(true);
    expect(insideDisplay2(appWindow.bounds)).toBe(true);

    await startHostAndSend(launched.page, promptA);
    await expect
      .poll(() => readFile(startA, "utf8").catch(() => ""), { timeout: 75_000 })
      .toContain("write-ahead recorded");
    await expect
      .poll(
        async () =>
          (await launched!.page.evaluate(() => window.zeno.prsloy.cuaRecovery.list())).length,
        { timeout: 30_000 },
      )
      .toBe(1);

    const afterA = await hostMetrics(launched);
    expect(afterA).toHaveLength(1);
    for (const host of afterA) hostIdentities.set(host.pid, host.creationTime);

    // The delayed native action has its durable recovery record. Creating another chat
    // parks Host A and starts a second utility process against the same isolated profile.
    await launched.page.getByTestId("start-host").click({ force: true });
    await expect(launched.page.getByTestId("runtime-snapshot").first()).toContainText("runtimeId", {
      timeout: 60_000,
    });
    await expect
      .poll(
        async () => {
          const hosts = await hostMetrics(launched!);
          for (const host of hosts) hostIdentities.set(host.pid, host.creationTime);
          return hosts.length;
        },
        { timeout: 45_000 },
      )
      .toBeGreaterThanOrEqual(2);

    await sendPrompt(launched.page, promptB);
    await expect.poll(() => gateway!.bBlocked, { timeout: 90_000 }).toBe(true);
    await expect.poll(() => gateway!.bReadTwice, { timeout: 15_000 }).toBe(true);
    await expect.poll(() => gateway!.bEffectAbsentAtBlock, { timeout: 15_000 }).toBe(true);
    await expect
      .poll(() => readFile(outputA, "utf8").catch(() => ""), { timeout: 30_000 })
      .toBe("A-effect-completed");

    const hostsAtAssertion = await hostMetrics(launched);
    for (const host of hostsAtAssertion) hostIdentities.set(host.pid, host.creationTime);
    expect(
      hostsAtAssertion.length,
      "both packaged utility processes must still be real and alive",
    ).toBeGreaterThanOrEqual(2);
    expect(new Set(hostsAtAssertion.map((host) => host.pid)).size).toBeGreaterThanOrEqual(2);
    expect(gateway.aTargetVerified).toBe(true);
    expect(gateway.bTargetVerified).toBe(true);
    expect(gateway.bReadTwice).toBe(true);
    expect(gateway.bBlocked).toBe(true);
    expect(gateway.bEffectAbsentAtBlock).toBe(true);
    expect(await readFile(outputB, "utf8").catch(() => "")).toBe("");
    expect(gateway.blockedErrorExcerpt).toMatch(
      /CUA_RECOVERY_BLOCKED|recovery|recovery review|pending action|pending.*computer/iu,
    );

    await writeFile(
      evidencePath,
      JSON.stringify(
        {
          packagedExecutable: packaged,
          cuaBinary,
          appHwnd,
          appPid: appWindow.pid,
          appBounds: appWindow.bounds,
          fixtureProcesses: fixturePids.map((pid) => ({
            pid,
            bounds: fixtureBoundsByPid.get(pid),
          })),
          agentHosts: hostsAtAssertion,
          hostAWriteAhead: (await readFile(startA, "utf8")).trim(),
          hostAResult: await readFile(outputA, "utf8"),
          hostBEffect: await readFile(outputB, "utf8").catch(() => null),
          bReadSnapshots: gateway.bReadSnapshots,
          blockedErrorExcerpt: gateway.blockedErrorExcerpt,
          windowsVerified: gateway.verifiedWindows,
        },
        null,
        2,
      ),
    );
    await test.info().attach("cua-concurrent-packaged-evidence", {
      path: evidencePath,
      contentType: "application/json",
    });
  } finally {
    // Closing the test app owns Agent Host shutdown. Never kill by a stale PID after
    // app exit: Windows may already have reused it for an unrelated user process.
    await launched?.app.close().catch(() => undefined);
    await launched?.fakeModel.stop().catch(() => undefined);
    lingeringHosts = [...hostIdentities].filter(([pid, created]) => isSameProcess(pid, created));
    for (const child of fixtureProcesses) {
      // Use the original ChildProcess handle; never select another process by PID.
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    await gateway?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    await rm(build, { recursive: true, force: true }).catch(() => undefined);
  }
  expect(lingeringHosts, "test Agent Hosts must exit after their app closes").toHaveLength(0);
});

type ConcurrentGateway = {
  baseUrl: string;
  aTargetVerified: boolean;
  bTargetVerified: boolean;
  bReadTwice: boolean;
  bReadSnapshots: string[];
  bBlocked: boolean;
  bEffectAbsentAtBlock: boolean;
  blockedErrorExcerpt: string;
  verifiedWindows: { pid: number; hwnd: number; title: string; bounds: unknown }[];
  close(): Promise<void>;
};

async function startGateway(
  pidA: number,
  pidB: number,
  outputA: string,
  outputB: string,
): Promise<ConcurrentGateway> {
  const state: ConcurrentGateway = {
    baseUrl: "",
    aTargetVerified: false,
    bTargetVerified: false,
    bReadTwice: false,
    bReadSnapshots: [],
    bBlocked: false,
    bEffectAbsentAtBlock: false,
    blockedErrorExcerpt: "",
    verifiedWindows: [],
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
      const body = JSON.parse(raw) as { messages?: Message[] };
      const messages = body.messages ?? [];
      const serializedMessages = JSON.stringify(messages);
      const markedA = serializedMessages.includes("PRSLOY_CONCURRENT_HOST_A");
      const markedB = serializedMessages.includes("PRSLOY_CONCURRENT_HOST_B");
      const isA = markedA || (!markedB && serializedMessages.includes(String(pidA)));
      const isB = markedB || (!markedA && serializedMessages.includes(String(pidB)));
      if (!isA && !isB) throw new Error("concurrent scripted gateway got an unknown turn");
      const results = messages.filter((item) => item.role === "tool");
      const step = results.length;
      const lastResultText = allText(results.at(-1)?.content);
      const lastResult = results.at(-1)?.content;
      let call: { name: string; args: Record<string, unknown> } | undefined;

      if (isA) {
        if (step === 0) call = { name: "cua_list_windows", args: {} };
        else if (step === 1) {
          const target = parseWindows(lastResult, pidA).find((row) => row.title.includes(titleA));
          if (!target) throw new Error("Host A could not see its own fixture HWND");
          verifyWindow(target, fixtureBoundsA, state);
          state.aTargetVerified = true;
          call = {
            name: "cua_get_window_state",
            args: { pid: target.pid, window_id: target.window_id },
          };
        } else if (step === 2) {
          const snap = extractSnapshot(lastResult);
          const target = latestVerified(state, pidA, titleA);
          call = {
            name: "cua_click",
            args: {
              pid: target.pid,
              window_id: target.hwnd,
              element_token: findToken(snap, /start delayed side effect|fixtureDelayed/iu),
            },
          };
        }
      } else {
        if (step === 0) call = { name: "cua_list_windows", args: {} };
        else if (step === 1) {
          const target = parseWindows(lastResult, pidB).find((row) => row.title.includes(titleB));
          if (!target) throw new Error("Host B could not see its own fixture HWND");
          verifyWindow(target, fixtureBoundsB, state);
          state.bTargetVerified = true;
          call = {
            name: "cua_get_window_state",
            args: { pid: target.pid, window_id: target.window_id },
          };
        } else if (step === 2) {
          state.bReadSnapshots.push(lastResultText.slice(0, 800));
          call = {
            name: "cua_get_window_state",
            args: { pid: pidB, window_id: latestVerified(state, pidB, titleB).hwnd },
          };
        } else if (step === 3) {
          const snap = extractSnapshot(lastResult);
          state.bReadSnapshots.push(lastResultText.slice(0, 800));
          state.bReadTwice =
            /Ready/u.test(state.bReadSnapshots.join("\n")) && state.bReadSnapshots.length === 2;
          const target = latestVerified(state, pidB, titleB);
          call = {
            name: "cua_click",
            args: {
              pid: target.pid,
              window_id: target.hwnd,
              element_token: findToken(snap, /save b effect|fixtureSave/iu),
            },
          };
        } else if (step === 4) {
          state.blockedErrorExcerpt = lastResultText.slice(0, 1200);
          state.bBlocked =
            /CUA_RECOVERY_BLOCKED|recovery|pending action|pending.*computer|action.*review/iu.test(
              lastResultText,
            );
          state.bEffectAbsentAtBlock = (await readFile(outputB, "utf8").catch(() => "")) === "";
        }
      }

      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const send = (delta: Record<string, unknown>, finish: string | null = null) => {
        res.write(
          `data: ${JSON.stringify({ id: "cua-concurrent-e2e", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        );
      };
      send({ role: "assistant", content: "" });
      if (call) {
        send({
          tool_calls: [
            {
              index: 0,
              id: `concurrent-${isA ? "a" : "b"}-${step}`,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            },
          ],
        });
        send({}, "tool_calls");
      } else {
        send({
          content: isA
            ? "Host A delayed action was issued."
            : "Host B read succeeded and its click was recovery-blocked.",
        });
        send({}, "stop");
      }
      res.end("data: [DONE]\n\n");
    })().catch((error) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("scripted concurrent gateway did not bind");
  state.baseUrl = `http://127.0.0.1:${address.port}/v1`;
  state.close = async () => {
    server.closeAllConnections();
    server.close();
    await new Promise<void>((resolve) => server.once("close", resolve));
  };
  return state;

  function verifyWindow(
    row: WindowRow,
    expected: typeof fixtureBoundsA,
    gateway: ConcurrentGateway,
  ): void {
    const native = readExactWindowInfo(row.window_id);
    expect(native.pid, `HWND ${row.window_id} belongs to fixture PID ${row.pid}`).toBe(row.pid);
    expect(
      nearBounds(native.bounds, expected),
      `${row.title} native bounds must match the planned DISPLAY2 placement`,
    ).toBe(true);
    expect(insideDisplay2(native.bounds), `${row.title} must be on DISPLAY2`).toBe(true);
    gateway.verifiedWindows.push({
      pid: row.pid,
      hwnd: row.window_id,
      title: row.title,
      bounds: native.bounds,
    });
  }
}

function latestVerified(
  gateway: ConcurrentGateway,
  pid: number,
  title: string,
): { pid: number; hwnd: number } {
  const row = [...gateway.verifiedWindows]
    .reverse()
    .find((item) => item.pid === pid && item.title.includes(title));
  if (!row) throw new Error(`No verified HWND for ${title}`);
  return { pid: row.pid, hwnd: row.hwnd };
}

async function startHostAndSend(page: import("playwright").Page, prompt: string): Promise<void> {
  await page.getByTestId("zeno-app").waitFor({ state: "visible" });
  await page.waitForSelector('[data-testid="zeno-app"][data-bootstrap-ready="true"]', {
    timeout: 120_000,
  });
  const trust = page.getByTestId("project-trust-dialog-trust");
  if (await trust.isVisible().catch(() => false)) await trust.click();
  const snapshot = page.getByTestId("runtime-snapshot").first();
  if (!/"runtimeId":\s*"([^"]+)"/u.test((await snapshot.textContent().catch(() => "")) ?? "")) {
    await page.getByTestId("start-host").click({ force: true });
    if (await trust.isVisible().catch(() => false)) await trust.click();
    await expect(snapshot).toContainText("runtimeId", { timeout: 60_000 });
  }
  await expect(page.getByTestId("host-status").first()).toContainText(
    /Agent Host ready|Agent Host restarted|Agent settled|就绪/u,
    { timeout: 45_000 },
  );
  await page.getByTestId("prompt-input").fill(prompt);
  await page.getByTestId("send-prompt").click();
}

function sendPrompt(page: import("playwright").Page, prompt: string): Promise<void> {
  return startHostAndSend(page, prompt);
}

async function hostMetrics(
  launched: Awaited<ReturnType<typeof launchZenoApp>>,
): Promise<HostIdentity[]> {
  return launched.app.evaluate(({ app }) =>
    app
      .getAppMetrics()
      .filter((metric) => metric.name === "PRSLOY Agent Host")
      .map(({ pid, creationTime }) => ({ pid, creationTime })),
  );
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

function allObjects(
  value: unknown,
  rows: Record<string, unknown>[] = [],
): Record<string, unknown>[] {
  if (typeof value === "string") {
    try {
      allObjects(JSON.parse(value) as unknown, rows);
    } catch {
      /* text-only tool output */
    }
  } else if (Array.isArray(value)) {
    for (const item of value) allObjects(item, rows);
  } else if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    rows.push(row);
    for (const item of Object.values(row)) allObjects(item, rows);
  }
  return rows;
}

function parseWindows(content: unknown, pid: number): WindowRow[] {
  const rows = allObjects(content).flatMap((row) => {
    const id = row.window_id ?? row.windowId;
    const title = row.title ?? row.window_title;
    return row.pid === pid && Number.isSafeInteger(id) && typeof title === "string"
      ? [{ pid, window_id: Number(id), title }]
      : [];
  });
  const text = allText(content).replace(/\\(["\\])/gu, "$1");
  for (const match of text.matchAll(
    /\(pid\s+(\d+)\)\s+["“]([^"”]+)["”]\s+\[window_id:\s*(\d+)\]/gimu,
  )) {
    if (Number(match[1]) === pid && !rows.some((row) => row.window_id === Number(match[3]))) {
      rows.push({ pid, title: match[2]!, window_id: Number(match[3]) });
    }
  }
  return rows;
}

function extractSnapshot(content: unknown): Snapshot {
  const rows = allObjects(content);
  const parent = rows.find((row) => Array.isArray(row.elements));
  const snapshot = rows.find((row) => typeof row.snapshot_id === "string");
  const text = allText(content);
  const id =
    typeof snapshot?.snapshot_id === "string"
      ? snapshot.snapshot_id
      : text.match(/\bs[0-9a-f]{8}\b/iu)?.[0];
  return {
    ...(id ? { snapshot_id: id } : {}),
    ...(Array.isArray(parent?.elements)
      ? { elements: parent.elements as Record<string, unknown>[] }
      : {}),
    markdown: text,
  };
}

function findToken(snapshot: Snapshot, label: RegExp): string {
  const row = snapshot.elements?.find(
    (item) => typeof item.element_token === "string" && label.test(JSON.stringify(item)),
  );
  if (typeof row?.element_token === "string") return row.element_token;
  const line = (snapshot.markdown ?? "").split(/\r?\n/u).find((item) => label.test(item));
  const index = line?.match(/^\s*(?:-\s*)?\[(\d+)\]/u)?.[1];
  if (snapshot.snapshot_id && index) return `${snapshot.snapshot_id}:${index}`;
  throw new Error(`Could not find Cua element matching ${label}`);
}

function insideDisplay2(bounds: { x: number; y: number; width: number; height: number }): boolean {
  return (
    bounds.x >= 2560 &&
    bounds.y >= 0 &&
    bounds.x + bounds.width <= 4480 &&
    bounds.y + bounds.height <= 1032
  );
}

function nearBounds(
  actual: { x: number; y: number; width: number; height: number },
  planned: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    Math.abs(actual.x - planned.x) <= 20 &&
    Math.abs(actual.y - planned.y) <= 20 &&
    Math.abs(actual.width - planned.width) <= 24 &&
    Math.abs(actual.height - planned.height) <= 24
  );
}

function readExactWindowInfo(hwnd: number): {
  pid: number;
  bounds: { x: number; y: number; width: number; height: number };
} {
  if (!Number.isSafeInteger(hwnd) || hwnd <= 0) throw new Error(`Invalid native HWND ${hwnd}`);
  const script = `$source = @'\nusing System;\nusing System.Runtime.InteropServices;\npublic static class PrsloyConcurrentWindow {\n[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }\n[DllImport("user32.dll", SetLastError=true)] static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);\n[DllImport("user32.dll", SetLastError=true)] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);\npublic static int[] Read(long hwnd) { uint pid; RECT r; if (GetWindowThreadProcessId(new IntPtr(hwnd), out pid)==0 || !GetWindowRect(new IntPtr(hwnd), out r)) throw new Exception("native HWND query failed"); return new int[]{(int)pid,r.Left,r.Top,r.Right-r.Left,r.Bottom-r.Top}; }\n}\n'@\nAdd-Type -TypeDefinition $source -ErrorAction Stop\n[PrsloyConcurrentWindow]::Read(${hwnd}) | ConvertTo-Json -Compress`;
  const output = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  const [pid, x, y, width, height] = JSON.parse(output) as number[];
  if (![pid, x, y, width, height].every(Number.isFinite))
    throw new Error(`Invalid native window data for ${hwnd}`);
  return { pid: pid!, bounds: { x: x!, y: y!, width: width!, height: height! } };
}

async function waitForFixtureWindow(pid: number, title: string): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    const currentTitle = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).MainWindowTitle`,
      ],
      { encoding: "utf8", windowsHide: true },
    ).trim();
    if (currentTitle === title) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Fixture HWND for owned process ${pid} did not appear: ${title}`);
}

function isSameProcess(pid: number, creationTime: number): boolean {
  const script = `try { $p=Get-Process -Id ${pid} -ErrorAction Stop; [DateTimeOffset]$p.StartTime | % { $_.ToUnixTimeMilliseconds() } } catch {}; exit 0`;
  const value = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  return value !== "" && Math.abs(Number(value) - creationTime) < 2000;
}
