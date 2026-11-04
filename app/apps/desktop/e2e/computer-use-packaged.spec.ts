import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { createServer, type Server } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchZenoApp, startHost, waitSettled } from "./fixtures.ts";

const munim = process.env.PRSLOY_MUNIM_BINARY?.trim();
const fixtureExe = process.env.PRSLOY_COMPUTER_USE_FIXTURE?.trim();
const marker = "PRSLOY-PACKAGED-MUNIM-E2E";

// Superseded by munim-recovery-packaged.spec.ts, which uses the current guarded wrapper.
test.skip("packaged PRSLOY uses real Munim for observe, stale rejection, type, click, screenshot", async () => {
  test.skip(!process.env.PRSLOY_E2E_PACKAGED, "requires a packaged Windows executable");
  test.skip(process.platform !== "win32", "real Munim UIA is Windows-only");
  test.skip(!munim || !fixtureExe, "set Munim binary and isolated WinForms fixture paths");
  test.setTimeout(180_000);

  const fixtureRoot = await mkdtemp(join(tmpdir(), "prsloy-munim-packaged-"));
  const outputFile = join(fixtureRoot, "result.txt");
  const fixtureDll = fixtureExe!.replace(/\.exe$/iu, ".dll");
  // Keep the WinForms top-level window visible to UI Automation; only its own console is hidden.
  const fixture = spawn("dotnet", [fixtureDll, outputFile], { stdio: "ignore" });
  let launched: Awaited<ReturnType<typeof launchZenoApp>> | undefined;
  let gateway: ScriptedGateway | undefined;
  try {
    await waitForFixtureWindow();
    launched = await launchZenoApp({
      tools:
        "read,mcp__munimComputerUse__list_apps,mcp__munimComputerUse__get_app_state,mcp__munimComputerUse__type_text,mcp__munimComputerUse__click,mcp__munimComputerUse__screenshot",
      env: {
        PRSLOY_COMPUTER_USE: "1",
        PRSLOY_MUNIM_BINARY: munim!,
      },
    });

    const configText = await readFile(join(launched.agentDir, "mcp.json"), "utf8");
    const config = JSON.parse(configText) as { mcpServers?: Record<string, { command?: string }> };
    expect(config.mcpServers?.munimComputerUse?.command).toBe(munim);

    await launched.fakeModel.stop();
    gateway = await startScriptedGateway(fixture.pid ?? 0, marker);
    const modelsPath = join(launched.agentDir, "models.json");
    const models = JSON.parse(await readFile(modelsPath, "utf8")) as {
      providers: Record<
        string,
        {
          baseUrl: string;
          apiKey: string;
          models: { input: string[] }[];
        }
      >;
    };
    const provider = models.providers["zeno-fake"];
    expect(provider).toBeDefined();
    if (!provider) throw new Error("fixture model provider missing");
    provider.baseUrl = gateway.baseUrl;
    provider.apiKey = "local-e2e-only";
    provider.models[0]!.input = ["text", "image"];
    await writeFile(modelsPath, JSON.stringify(models, null, 2));

    await startHost(launched.page);
    const trust = launched.page.getByTestId("project-trust-dialog-trust");
    if (await trust.isVisible().catch(() => false)) await trust.click();
    const prompt = launched.page.getByTestId("prompt-input");
    await prompt.click();
    await prompt.pressSequentially("Run the packaged Munim computer-use fixture task.");
    await launched.page.getByTestId("send-prompt").click();
    await waitSettled(launched.page);

    const result = await readFile(outputFile, "utf8");
    expect(result).toBe(marker);
    expect(gateway.rejectedStale).toBe(true);
    expect(gateway.imageSeenAfterScreenshot, gateway.lastRequestShape).toBe(true);
    expect(gateway.savedStateSeen).toBe(true);
    expect(gateway.toolSequence).toEqual([
      "list_apps",
      "get_app_state",
      "type_text",
      "click",
      "get_app_state",
      "click",
      "get_app_state",
      "screenshot",
    ]);
  } finally {
    await launched?.app.close().catch(() => undefined);
    await gateway?.close();
    try {
      fixture.kill();
    } catch {
      /* already closed */
    }
    await rm(fixtureRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});

// Superseded by munim-stop-packaged.spec.ts, which tests Stop during an actual side effect.
test.skip("packaged PRSLOY aborts a real Munim wait and never reports it as success", async () => {
  test.skip(!process.env.PRSLOY_E2E_PACKAGED, "requires a packaged Windows executable");
  test.skip(process.platform !== "win32", "real Munim UIA is Windows-only");
  test.skip(!munim, "set PRSLOY_MUNIM_BINARY");
  test.setTimeout(120_000);

  const stopRoot = await mkdtemp(join(tmpdir(), "prsloy-munim-stop-"));
  const proxyDir = join(stopRoot, "munim-proxy");
  await mkdir(proxyDir, { recursive: true });
  execFileSync(
    "dotnet",
    [
      "publish",
      fileURLToPath(new URL("./munim-proxy/MunimProxy.csproj", import.meta.url)),
      "-c",
      "Release",
      "-o",
      proxyDir,
      `-p:BaseIntermediateOutputPath=${join(proxyDir, "obj")}${sep}`,
      `-p:MSBuildProjectExtensionsPath=${join(proxyDir, "obj")}${sep}`,
    ],
    { stdio: "pipe" },
  );
  const proxyExe = join(proxyDir, "munim-computer-use.exe");
  const proxyLog = join(stopRoot, "munim-proxy.jsonl");
  let launched: Awaited<ReturnType<typeof launchZenoApp>> | undefined;
  let gateway: ScriptedGateway | undefined;
  try {
    launched = await launchZenoApp({
      tools: "read,mcp__munimComputerUse__wait",
      env: { PRSLOY_COMPUTER_USE: "1", PRSLOY_MUNIM_BINARY: proxyExe },
    });
    const mcpPath = join(launched.agentDir, "mcp.json");
    const mcp = JSON.parse(await readFile(mcpPath, "utf8")) as {
      mcpServers: Record<string, { command: string; env?: Record<string, string> }>;
    };
    const munimConfig = mcp.mcpServers.munimComputerUse;
    if (!munimConfig) throw new Error("Munim server config missing");
    expect(munimConfig?.command).toBe(proxyExe);
    munimConfig.env = {
      ...munimConfig.env,
      MUNIM_PROXY_TARGET: munim!,
      MUNIM_PROXY_LOG: proxyLog,
    };
    await writeFile(mcpPath, JSON.stringify(mcp, null, 2));
    const config = JSON.parse(await readFile(join(launched.agentDir, "models.json"), "utf8")) as {
      providers: Record<string, { baseUrl: string; apiKey: string }>;
    };
    await launched.fakeModel.stop();
    gateway = await startScriptedGateway(0, "", "stop");
    const provider = config.providers["zeno-fake"];
    if (!provider) throw new Error("fixture model provider missing");
    provider.baseUrl = gateway.baseUrl;
    provider.apiKey = "local-e2e-only";
    await writeFile(join(launched.agentDir, "models.json"), JSON.stringify(config, null, 2));

    await startHost(launched.page);
    const trust = launched.page.getByTestId("project-trust-dialog-trust");
    if (await trust.isVisible().catch(() => false)) await trust.click();
    const prompt = launched.page.getByTestId("prompt-input");
    await prompt.click();
    await prompt.pressSequentially("Start a long Munim wait; I will stop it.");
    await launched.page.getByTestId("send-prompt").click();
    await expect.poll(() => gateway!.waitRequested).toBe(true);
    await expect
      .poll(
        async () =>
          (await readFile(proxyLog, "utf8").catch(() => "")).includes(
            '"direction":"forwarded-to-munim"',
          ) &&
          (await readFile(proxyLog, "utf8").catch(() => "")).includes(
            '"method":"tools/call","name":"wait"',
          ),
      )
      .toBe(true);
    await expect(launched.page.getByTestId("abort-prompt")).toBeVisible({ timeout: 20_000 });
    // Require an actual stdio tools/call forwarded to Munim before stopping.
    await expect(launched.page.locator('[data-kind="tool"][data-status="running"]')).toHaveCount(
      1,
      { timeout: 20_000 },
    );
    await launched.page.getByTestId("abort-prompt").click({ force: true });
    await expect(launched.page.getByTestId("host-status").first()).toContainText(
      /Agent aborted|Agent settled/,
      { timeout: 30_000 },
    );
    expect(gateway.finalSuccess).toBe(false);
    await expect
      .poll(
        async () => {
          const log = await readFile(proxyLog, "utf8").catch(() => "");
          return (
            log.includes(
              '"direction":"forwarded-to-munim","id":null,"method":"notifications/cancelled"',
            ) ||
            /"direction":"from-munim","id":"[^"]+","method":"tools\/call","hasError":true/u.test(
              log,
            ) ||
            log.includes('"direction":"munim-exit"')
          );
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    const proxyEvents = (await readFile(proxyLog, "utf8"))
      .split(/\r?\n/u)
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            direction?: string;
            method?: string;
            name?: string;
            hasError?: boolean;
            requestId?: string;
            forcedKill?: boolean;
          },
      );
    const stdioCancellationObserved = proxyEvents.some(
      (event) =>
        event.direction === "forwarded-to-munim" &&
        event.method === "notifications/cancelled" &&
        event.requestId !== undefined,
    );
    const backendRejectedCall = proxyEvents.some(
      (event) =>
        event.direction === "from-munim" &&
        event.method === "tools/call" &&
        event.hasError === true,
    );
    const backendExit = proxyEvents.find((event) => event.direction === "munim-exit");
    const backendNaturalExit = backendExit?.forcedKill === false;
    const backendForcedKill = backendExit?.forcedKill === true;
    console.info(
      "[munim-stop-stdio]",
      JSON.stringify({
        stdioCancellationObserved,
        backendRejectedCall,
        backendNaturalExit,
        backendForcedKill,
        backendStopObserved: backendRejectedCall || backendNaturalExit,
      }),
    );
    expect(
      proxyEvents.some(
        (event) =>
          event.direction === "forwarded-to-munim" &&
          event.method === "tools/call" &&
          event.name === "wait",
      ),
    ).toBe(true);
    expect(stdioCancellationObserved || backendRejectedCall || backendExit !== undefined).toBe(
      true,
    );
  } finally {
    await launched?.app.close().catch(() => undefined);
    await gateway?.close();
    await rm(stopRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});

// The old raw-tool/proxy contract is gone; the opt-out replacement is tracked separately.
test.skip("packaged PRSLOY opts out of owned Munim on the same profile and keeps the ordinary host working", async () => {
  test.skip(!process.env.PRSLOY_E2E_PACKAGED, "requires a packaged Windows executable");
  test.skip(process.platform !== "win32", "real Munim UIA is Windows-only");
  test.skip(!munim, "set Munim binary");
  test.setTimeout(150_000);

  const root = await mkdtemp(join(tmpdir(), "prsloy-munim-optout-"));
  const proxyDir = join(root, "munim-proxy");
  const proxyLog = join(root, "munim-proxy.jsonl");
  await mkdir(proxyDir, { recursive: true });
  execFileSync(
    "dotnet",
    [
      "publish",
      fileURLToPath(new URL("./munim-proxy/MunimProxy.csproj", import.meta.url)),
      "-c",
      "Release",
      "-o",
      proxyDir,
      `-p:BaseIntermediateOutputPath=${join(proxyDir, "obj")}${sep}`,
      `-p:MSBuildProjectExtensionsPath=${join(proxyDir, "obj")}${sep}`,
    ],
    { stdio: "pipe" },
  );
  const proxyExe = join(proxyDir, "munim-computer-use.exe");
  let optIn: Awaited<ReturnType<typeof launchZenoApp>> | undefined;
  let optOut: Awaited<ReturnType<typeof launchZenoApp>> | undefined;
  try {
    optIn = await launchZenoApp({
      root,
      tools: "read,mcp__munimComputerUse__list_apps",
      toolCall: { name: "mcp__munimComputerUse__list_apps", arguments: {} },
      env: { PRSLOY_COMPUTER_USE: "1", PRSLOY_MUNIM_BINARY: proxyExe },
    });
    const mcpPath = join(optIn.agentDir, "mcp.json");
    const mcp = JSON.parse(await readFile(mcpPath, "utf8")) as {
      mcpServers: Record<string, { command: string; env?: Record<string, string> }>;
    };
    const server = mcp.mcpServers.munimComputerUse;
    if (!server) throw new Error("Munim server config missing");
    expect(server.command).toBe(proxyExe);
    server.env = {
      ...server.env,
      MUNIM_PROXY_TARGET: munim!,
      MUNIM_PROXY_LOG: proxyLog,
    };
    await writeFile(mcpPath, JSON.stringify(mcp, null, 2));
    await startOrReuseHost(optIn.page);
    const trust = optIn.page.getByTestId("project-trust-dialog-trust");
    if (await trust.isVisible().catch(() => false)) await trust.click();
    const optInRequestCount = optIn.fakeModel.requests.length;
    await optIn.page
      .getByTestId("prompt-input")
      .fill("Use the tool to check connected applications.");
    await optIn.page.getByTestId("send-prompt").click();
    await expect.poll(() => optIn!.fakeModel.requests.length).toBeGreaterThan(optInRequestCount);
    await waitSettled(optIn.page);
    await expect
      .poll(async () =>
        (await readFile(proxyLog, "utf8").catch(() => "")).includes('"name":"list_apps"'),
      )
      .toBe(true);
    const optInEvents = (await readFile(proxyLog, "utf8"))
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { direction?: string; method?: string; name?: string });
    expect(
      optInEvents.some(
        (event) =>
          event.direction === "forwarded-to-munim" &&
          event.method === "tools/call" &&
          event.name === "list_apps",
      ),
    ).toBe(true);
    await optIn.app.close();
    await optIn.fakeModel.stop();
    optIn = undefined;
    await expect
      .poll(async () =>
        (await readFile(proxyLog, "utf8").catch(() => "")).includes('"direction":"munim-exit"'),
      )
      .toBe(true);
    const eventCountBeforeOptOut = (await readFile(proxyLog, "utf8"))
      .split(/\r?\n/u)
      .filter(Boolean).length;

    optOut = await launchZenoApp({
      root,
      tools: "read",
      reply: () => "Ordinary host works after opt-out.",
      env: { PRSLOY_COMPUTER_USE: "", PRSLOY_MUNIM_BINARY: "" },
    });
    const disabledMcp = JSON.parse(await readFile(join(optOut.agentDir, "mcp.json"), "utf8")) as {
      mcpServers: Record<string, { disabled?: boolean; enabled?: boolean }>;
    };
    expect(disabledMcp.mcpServers.munimComputerUse).toMatchObject({
      disabled: true,
      enabled: false,
    });
    await startOrReuseHost(optOut.page);
    const optOutTrust = optOut.page.getByTestId("project-trust-dialog-trust");
    if (await optOutTrust.isVisible().catch(() => false)) await optOutTrust.click();
    await optOut.page.getByTestId("prompt-input").fill("Say hello in one sentence.");
    const optOutRequestCount = optOut.fakeModel.requests.length;
    await optOut.page.getByTestId("send-prompt").click();
    await expect.poll(() => optOut!.fakeModel.requests.length).toBeGreaterThan(optOutRequestCount);
    await waitSettled(optOut.page);
    const request = optOut.fakeModel.requests.at(-1);
    expect(JSON.stringify(request ?? {}).includes("mcp__munimComputerUse")).toBe(false);
    await expect
      .poll(async () => (await readFile(proxyLog, "utf8")).split(/\r?\n/u).filter(Boolean).length)
      .toBe(eventCountBeforeOptOut);
  } finally {
    await optIn?.app.close().catch(() => undefined);
    await optIn?.fakeModel.stop().catch(() => undefined);
    await optOut?.app.close().catch(() => undefined);
    await optOut?.fakeModel.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function startOrReuseHost(page: import("@playwright/test").Page): Promise<void> {
  await page.getByTestId("zeno-app").waitFor({ state: "visible" });
  await page.waitForSelector('[data-testid="zeno-app"][data-bootstrap-ready="true"]', {
    timeout: 120_000,
  });
  const snapshot = await page
    .getByTestId("runtime-snapshot")
    .first()
    .textContent()
    .catch(() => "");
  if (!/"runtimeId":\s*"([^"]+)"/u.test(snapshot ?? "")) {
    await startHost(page);
    return;
  }
  await expect(page.getByTestId("host-status").first()).toContainText(
    /Agent Host ready|Agent Host restarted|Agent settled|就绪/,
    { timeout: 45_000 },
  );
}

type ScriptedGateway = {
  baseUrl: string;
  toolSequence: string[];
  rejectedStale: boolean;
  imageSeenAfterScreenshot: boolean;
  savedStateSeen: boolean;
  lastRequestShape: string;
  waitRequested: boolean;
  finalSuccess: boolean;
  close(): Promise<void>;
};

async function startScriptedGateway(
  targetPid: number,
  expectedMarker: string,
  mode: "cycle" | "stop" = "cycle",
): Promise<ScriptedGateway> {
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
      const userIndex = messages.findLastIndex(
        (m) =>
          m.role === "user" &&
          textOf(m.content).includes("Run the packaged Munim computer-use fixture task."),
      );
      const turn = messages.slice(userIndex + 1);
      const toolResults = turn.filter((m) => m.role === "tool");
      if (messages.some(hasImageUrl)) gateway.imageSeenAfterScreenshot = true;
      if (JSON.stringify(messages).includes(`Saved: ${expectedMarker}`))
        gateway.savedStateSeen = true;
      gateway.lastRequestShape = JSON.stringify(
        messages.map((m) => ({
          role: m.role,
          contentType: Array.isArray(m.content) ? "array" : typeof m.content,
          parts: Array.isArray(m.content)
            ? m.content.map((part) => {
                if (!part || typeof part !== "object") return typeof part;
                const row = part as Record<string, unknown>;
                return { type: row.type, keys: Object.keys(row), mimeType: row.mimeType };
              })
            : undefined,
          contentLength: typeof m.content === "string" ? m.content.length : undefined,
          toolText:
            m.role === "tool" && typeof m.content === "string"
              ? m.content.slice(0, 1200)
              : undefined,
          imageUrl: JSON.stringify(m.content ?? "").includes("image_url"),
          dataUri: JSON.stringify(m.content ?? "").includes("data:image/"),
        })),
      );

      const step = toolResults.length;
      if (step === 4) {
        const blocked = JSON.stringify(toolResults.at(-1)?.content ?? "");
        gateway.rejectedStale = /fresh|snapshot|перечитай|наблюден/iu.test(blocked);
      }
      let next: { name: string; args: Record<string, unknown> } | undefined;
      if (mode === "stop") {
        if (!gateway.waitRequested) {
          next = { name: "wait", args: { seconds: 30 } };
          gateway.waitRequested = true;
        } else gateway.finalSuccess = true;
      } else if (step === 0) next = { name: "list_apps", args: {} };
      else if (step === 1) next = { name: "get_app_state", args: { app: String(targetPid) } };
      else if (step === 2)
        next = { name: "type_text", args: { element_id: "e2", text: expectedMarker } };
      else if (step === 3) next = { name: "click", args: { element_id: "e2" } };
      else if (step === 4) next = { name: "get_app_state", args: { app: String(targetPid) } };
      else if (step === 5) next = { name: "click", args: { element_id: "e3" } };
      else if (step === 6) next = { name: "get_app_state", args: { app: String(targetPid) } };
      else if (step === 7) next = { name: "screenshot", args: { app: String(targetPid) } };
      else gateway.finalSuccess = true;

      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const send = (delta: Record<string, unknown>, finish: string | null = null) => {
        res.write(
          `data: ${JSON.stringify({ id: "packaged-munim-e2e", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        );
      };
      send({ role: "assistant", content: "" });
      if (next) {
        gateway.toolSequence.push(next.name);
        send({
          tool_calls: [
            {
              index: 0,
              id: `call-${step}`,
              type: "function",
              function: {
                name: `mcp__munimComputerUse__${next.name}`,
                arguments: JSON.stringify(next.args),
              },
            },
          ],
        });
        send({}, "tool_calls");
      } else {
        send({ content: mode === "stop" ? "Munim wait returned." : "Fixture flow complete." });
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
  if (!address || typeof address === "string") throw new Error("mock gateway did not bind");
  const gateway = {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    toolSequence: [] as string[],
    rejectedStale: false,
    imageSeenAfterScreenshot: false,
    savedStateSeen: false,
    lastRequestShape: "",
    waitRequested: false,
    finalSuccess: false,
    close: async () => {
      server.closeAllConnections();
      server.close();
      await new Promise<void>((resolve) => server.once("close", resolve));
    },
  };
  return gateway;
}

type GatewayMessage = { role?: string; content?: unknown; tool_calls?: unknown };

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

function hasImageUrl(message: GatewayMessage): boolean {
  const text = JSON.stringify(message.content ?? "");
  return text.includes("image_url") || text.includes("data:image/");
}

async function waitForFixtureWindow(): Promise<void> {
  const { execFileSync } = await import("node:child_process");
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const windows = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "Get-Process | Where-Object { $_.MainWindowTitle -eq 'PRSLOY 104 Test Fixture' } | Select-Object -ExpandProperty Id",
      ],
      { encoding: "utf8", windowsHide: true },
    ).trim();
    if (windows) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("WinForms Munim fixture window did not appear");
}
