import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "@playwright/test";
import { launchZenoApp, waitSettled } from "./fixtures.ts";

// Explicit local opt-in only. Never print or persist a decrypted gateway key.
test("packaged PRSLOY reaches the real gateway from an isolated profile", async () => {
  test.skip(process.env.PRSLOY_E2E_LIVE_GATEWAY !== "1", "requires explicit paid gateway opt-in");
  test.skip(
    !process.env.PRSLOY_E2E_GATEWAY_ENCRYPTED_KEY,
    "requires a separately entered encrypted test key",
  );
  test.skip(
    process.platform !== "win32" || !process.env.PRSLOY_E2E_PACKAGED,
    "requires packaged Windows app",
  );
  test.setTimeout(150_000);
  const publicRoot = resolve("C:\\Users\\Public\\Documents");
  const workspace = await mkdtemp(join(publicRoot, "prsloy-live-workspace-"));
  const privateTemp = resolve(tmpdir());
  const root = await mkdtemp(join(privateTemp, "prsloy-live-profile-"));
  if (
    !resolve(workspace).startsWith(`${publicRoot}${sep}`) ||
    !resolve(root).startsWith(`${privateTemp}${sep}`)
  )
    throw new Error("Unsafe test root");
  const sourceKey = process.env.PRSLOY_E2E_GATEWAY_ENCRYPTED_KEY!;
  const destination = join(root, "electron-userData", "prsloy");
  let launched: Awaited<ReturnType<typeof launchZenoApp>> | undefined;
  try {
    await mkdir(destination, { recursive: true });
    await copyFile(sourceKey, join(destination, "gateway-key.bin"));
    // Electron's Windows safeStorage can depend on the synthetic profile's
    // encrypted Local State key as well as the ciphertext. This file belongs
    // to the dedicated key-entry helper, never the user's normal profile.
    await copyFile(
      join(dirname(sourceKey), "electron-userdata", "Local State"),
      join(root, "electron-userData", "Local State"),
    );
    await writeFile(
      join(destination, "state.json"),
      JSON.stringify({
        baseUrl: "https://api.prsloy.online/v1",
        models: { ids: ["gpt-6.1-sol"], checkedAt: new Date().toISOString() },
      }),
    );
    await writeFile(
      join(root, "electron-userData", "zeno-desktop.json"),
      JSON.stringify({
        recentWorkspaces: [],
        window: { x: 2580, y: 500, width: 1000, height: 500 },
      }),
    );
    launched = await launchZenoApp({
      root,
      workspacePath: workspace,
      tools: "read",
      model: { provider: "prsloy", id: "gpt-6.1-sol" },
      env: { PRSLOY_COMPUTER_USE: "0", PRSLOY_CUA_BINARY: "", PRSLOY_BALANCE_WARN_RUB: "0" },
    });
    const windowBounds = await launched.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.getBounds(),
    );
    expect(windowBounds).toBeDefined();
    expect(windowBounds!.x).toBeGreaterThanOrEqual(2560);
    expect(windowBounds!.x + windowBounds!.width).toBeLessThanOrEqual(4480);
    expect(windowBounds!.y).toBeGreaterThanOrEqual(0);
    expect(windowBounds!.y + windowBounds!.height).toBeLessThanOrEqual(1032);
    const keyState = await launched.app.evaluate(({ app, safeStorage }) => {
      const fs = process.getBuiltinModule("node:fs")!;
      const path = process.getBuiltinModule("node:path")!;
      const filename = path.join(app.getPath("userData"), "prsloy", "gateway-key.bin");
      const present = fs.existsSync(filename);
      let decrypts = false;
      try {
        decrypts =
          present &&
          safeStorage.isEncryptionAvailable() &&
          safeStorage.decryptString(fs.readFileSync(filename)).trim().length > 0;
      } catch {
        decrypts = false;
      }
      return { present, available: safeStorage.isEncryptionAvailable(), decrypts };
    });
    expect(keyState).toEqual({ present: true, available: true, decrypts: true });
    const modelsPath = join(launched.agentDir, "models.json");
    const models = JSON.parse(await readFile(modelsPath, "utf8"));
    const model = models.providers.prsloy.models.find(
      (entry: { id: string }) => entry.id === "gpt-6.1-sol",
    );
    if (!model) throw new Error("Real model is not configured");
    model.maxTokens = 512;
    await writeFile(modelsPath, JSON.stringify(models));
    await launched.fakeModel.stop();
    await launched.page.waitForSelector('[data-testid="zeno-app"][data-bootstrap-ready="true"]', {
      timeout: 120_000,
    });
    const snapshot = launched.page.getByTestId("runtime-snapshot").first();
    const existingRuntime = await snapshot.textContent().catch(() => "");
    if (!/"runtimeId":\s*"([^"]+)"/u.test(existingRuntime ?? "")) {
      await launched.page.getByTestId("start-host").click({ force: true });
      await expect(snapshot).toContainText("runtimeId", { timeout: 60_000 });
    }
    await expect(launched.page.getByTestId("host-status").first()).toContainText(
      /Agent Host ready|Agent Host restarted|Agent settled|就绪/u,
      { timeout: 45_000 },
    );
    const trust = launched.page.getByTestId("project-trust-dialog-trust");
    if (await trust.isVisible().catch(() => false)) await trust.click();
    await launched.page.getByTestId("prompt-input").fill("Ответь ровно одним словом: ГОТОВО");
    await launched.page.getByTestId("send-prompt").click();
    await waitSettled(launched.page);
    await expect(
      launched.page
        .getByTestId("markdown-content")
        .getByText(/ГОТОВО/iu)
        .last(),
    ).toBeVisible({ timeout: 20_000 });
  } finally {
    await launched?.app.close().catch(() => undefined);
    await launched?.fakeModel.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});
