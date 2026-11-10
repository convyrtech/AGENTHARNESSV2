import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockGatewayServer } from "../../../packages/test-utils/src/index.ts";
import { expect, launchZenoApp, sendPrompt, startHost, test } from "./fixtures.ts";

test("delegate runs a scoped worker, verifies its change, and shows the parent summary", async () => {
  const root = await mkdtemp(join(tmpdir(), "prsloy-delegate-e2e-"));
  await mkdir(join(root, "home", "Documents"), { recursive: true });
  const gateway = new MockGatewayServer({
    apiKey: "delegate-e2e-key",
    modelIds: ["gpt-parent", "kimi-worker", "minimax-review"],
    turns: [
      {
        toolCall: {
          name: "delegate",
          arguments: {
            task: "Write working to result.txt",
            paths: ["result.txt"],
            check: "grep -qx working result.txt",
            workerModel: "test/kimi-worker",
            reviewerModel: "test/minimax-review",
          },
        },
      },
      { toolCall: { name: "write", arguments: { path: "result.txt", content: "working\n" } } },
      { text: "Changed result.txt. Verification pending." },
      { text: '{"verdict":"PASS","items":[]}' },
      { text: "Готово: result.txt записан и проверка прошла." },
    ],
  });
  await gateway.start();
  let launched: Awaited<ReturnType<typeof launchZenoApp>> | undefined;
  try {
    launched = await launchZenoApp({
      root,
      tools: "read,bash,delegate",
      model: { provider: "test", id: "gpt-parent" },
    });
    await writeFile(
      join(launched.agentDir, "models.json"),
      JSON.stringify({
        providers: {
          test: {
            baseUrl: gateway.baseUrl,
            apiKey: "delegate-e2e-key",
            api: "openai-completions",
            models: ["gpt-parent", "kimi-worker", "minimax-review"].map((id) => ({
              id,
              name: id,
              reasoning: false,
              input: ["text"],
              cost: { input: 1, output: 2, cacheRead: 1, cacheWrite: 1 },
              contextWindow: 32768,
              maxTokens: 8192,
            })),
          },
        },
      }),
    );
    await writeFile(
      join(launched.agentDir, "prsloy-harness.json"),
      JSON.stringify({
        delegate: true,
        secondOpinion: false,
        memory: false,
        autoMemory: "off",
        webTools: false,
        lessons: false,
        testGuard: false,
      }),
    );

    const { page } = launched;
    await startHost(page);
    const trustDialog = page.getByTestId("project-trust-dialog");
    if (await trustDialog.isVisible().catch(() => false)) {
      await page.getByTestId("project-trust-dialog-trust").click();
      await expect(trustDialog).toBeHidden({ timeout: 10_000 });
    }
    await sendPrompt(page, "Use delegate to write and verify result.txt.");
    await expect(page.getByTestId("host-status").first()).toContainText("Agent settled");
    await expect.poll(() => gateway.requests.length, { timeout: 30_000 }).toBe(5);
    expect(await readFile(join(launched.workspace, "result.txt"), "utf8")).toBe("working\n");
    expect(gateway.requests.map((request) => request.body.model)).toEqual([
      "gpt-parent",
      "kimi-worker",
      "kimi-worker",
      "minimax-review",
      "gpt-parent",
    ]);
    await expect(
      page.getByTestId("markdown-content").getByText("Готово: result.txt записан и проверка прошла.", {
        exact: true,
      }),
    ).toBeVisible();

    const sessionRoot = join(launched.agentDir, "sessions");
    const sessionFiles: string[] = [];
    async function collectFiles(directory: string): Promise<void> {
      for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await collectFiles(path);
        else if (entry.isFile() && entry.name.endsWith(".jsonl")) sessionFiles.push(path);
      }
    }
    await collectFiles(sessionRoot);
    const sessionText = (await Promise.all(sessionFiles.map((path) => readFile(path, "utf8")))).join("\n");
    expect(sessionText).toContain('"status":"verified"');
    const screenshot = test.info().outputPath("prsloy-delegate-cycle.png");
    await page.screenshot({ path: screenshot });
    expect(existsSync(screenshot)).toBe(true);
  } finally {
    await launched?.app.close().catch(() => undefined);
    await launched?.fakeModel.stop().catch(() => undefined);
    await gateway.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});
