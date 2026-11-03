import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, launchZenoApp, startHost, test, waitSettled } from "./fixtures.ts";

// Superseded by the guarded packaged Munim tests; the old raw-tool contract is no longer supported.
test.skip("Agent Host loads an opt-in stdio MCP server", async () => {
  test.setTimeout(180_000);
  const root = await mkdtemp(join("C:\\Users\\paxalb\\AppData\\Local\\Temp", "prsloy-mcp-"));
  const calls = join(root, "calls.jsonl");
  const pidFile = join(root, "mcp.pid");
  let launched: Awaited<ReturnType<typeof launchZenoApp>> | undefined;
  try {
    launched = await launchZenoApp({
      tools: "read,mcp__munimComputerUse__list_apps",
      mcpFixture: { name: "munimComputerUse", result: "MCP_OK", callsFile: calls, pidFile },
      toolCall: { name: "mcp__munimComputerUse__list_apps", arguments: {} },
    });
    const app = launched;
    await startHost(app.page);
    const trust = app.page.getByTestId("project-trust-dialog-trust");
    if (await trust.isVisible().catch(() => false)) await trust.click();
    const prompt = app.page.getByTestId("prompt-input");
    await prompt.click();
    await prompt.pressSequentially("Use the MCP fixture tool.");
    await app.page.getByTestId("send-prompt").click();
    await waitSettled(launched.page);
    await expect
      .poll(async () => (await readFile(calls, "utf8").catch(() => "")).trim())
      .toContain("{}");
    expect(JSON.stringify(launched.fakeModel.requests)).toContain("MCP_OK");
  } finally {
    await launched?.app.close().catch(() => undefined);
    await launched?.fakeModel.stop().catch(() => undefined);
    await stopFixture(pidFile);
    if (launched) await rm(launched.root, { recursive: true, force: true }).catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("Agent Host Stop aborts a hanging turn", async () => {
  test.setTimeout(180_000);
  let launched: Awaited<ReturnType<typeof launchZenoApp>> | undefined;
  try {
    launched = await launchZenoApp();
    const app = launched;
    await startHost(app.page);
    const trust = app.page.getByTestId("project-trust-dialog-trust");
    if (await trust.isVisible().catch(() => false)) await trust.click();
    const prompt = app.page.getByTestId("prompt-input");
    await prompt.click();
    await prompt.pressSequentially("ABORT this response after its first delta.");
    await expect(app.page.getByTestId("send-prompt")).toBeEnabled({ timeout: 30_000 });
    await app.page.getByTestId("send-prompt").click();
    await expect(app.page.getByTestId("host-status").first()).toContainText("Agent running");
    await expect
      .poll(async () => app.page.getByTestId("timeline").innerText(), { timeout: 30_000 })
      .toMatch(/Waiting for abort|abort/i);
    await app.page.getByTestId("abort-prompt").click({ force: true });
    await expect(app.page.getByTestId("host-status").first()).toContainText(
      /Agent aborted|Agent settled/,
      {
        timeout: 30_000,
      },
    );
  } finally {
    await launched?.app.close().catch(() => undefined);
    await launched?.fakeModel.stop().catch(() => undefined);
    if (launched) await rm(launched.root, { recursive: true, force: true }).catch(() => undefined);
  }
});

// The real side-effect Stop scenario is covered by munim-stop-packaged.spec.ts.
test.skip("Agent Host Stop aborts a hanging MCP tools/call", async () => {
  test.setTimeout(180_000);
  const root = await mkdtemp(join("C:\\Users\\paxalb\\AppData\\Local\\Temp", "prsloy-mcp-hang-"));
  const calls = join(root, "calls.jsonl");
  const pidFile = join(root, "mcp.pid");
  let launched: Awaited<ReturnType<typeof launchZenoApp>> | undefined;
  try {
    launched = await launchZenoApp({
      tools: "read,mcp__munimComputerUse__list_apps",
      mcpFixture: {
        name: "munimComputerUse",
        result: "never",
        callsFile: calls,
        hang: true,
        pidFile,
      },
      toolCall: { name: "mcp__munimComputerUse__list_apps", arguments: {} },
    });
    const app = launched;
    await startHost(app.page);
    const trust = app.page.getByTestId("project-trust-dialog-trust");
    if (await trust.isVisible().catch(() => false)) await trust.click();
    const prompt = app.page.getByTestId("prompt-input");
    await prompt.click();
    await prompt.pressSequentially("Use the MCP tool fixture and wait for its result.");
    await app.page.getByTestId("send-prompt").click();
    await expect
      .poll(async () => (await readFile(calls, "utf8").catch(() => "")).trim())
      .toContain("{}");
    await app.page.getByTestId("abort-prompt").click({ force: true });
    await expect(app.page.getByTestId("host-status").first()).toContainText(
      /Agent aborted|Agent settled/,
      {
        timeout: 30_000,
      },
    );
    await app.app.close().catch(() => undefined);
    expect(isProcessAlive(Number((await readFile(pidFile, "utf8").catch(() => "")).trim()))).toBe(
      false,
    );
  } finally {
    await launched?.app.close().catch(() => undefined);
    await launched?.fakeModel.stop().catch(() => undefined);
    await stopFixture(pidFile);
    if (launched) await rm(launched.root, { recursive: true, force: true }).catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function stopFixture(pidFile: string): Promise<void> {
  // A bare PID from a file is not a process identity and must never be killed.
  // The obsolete fixture is disposed by its owning Electron process.
  void pidFile;
}

function isProcessAlive(pid: number): boolean {
  if (!pid || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
