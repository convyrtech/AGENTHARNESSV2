import { rm } from "node:fs/promises";
import { expect, launchZenoApp, startHost, test } from "./fixtures.ts";

/**
 * PRSLOY: the Electron Agent Host loads @prsloy/harness in every session. A bash tool
 * result reaches the model with the harness header `[exit 0 · <время> · <размер>]`.
 */
test("harness header on bash tool results (fake model, real host)", async () => {
  const launched = await launchZenoApp({
    tools: "read,bash",
    toolCall: { name: "bash", arguments: { command: "echo harness-e2e" } },
  });
  try {
    const { page, fakeModel } = launched;
    await startHost(page);
    await page.getByTestId("prompt-input").fill("Use the tool please.");
    await page.getByTestId("send-prompt").click();
    await expect(page.getByTestId("host-status").first()).toContainText("Agent settled", {
      timeout: 60_000,
    });
    await expect
      .poll(
        () => {
          for (const request of fakeModel.requests) {
            for (const message of request.messages ?? []) {
              if (message.role !== "tool") continue;
              const content = message.content;
              return typeof content === "string"
                ? content
                : Array.isArray(content)
                  ? content.map((part: { text?: string }) => part.text ?? "").join("")
                  : "";
            }
          }
          return "";
        },
        { timeout: 30_000 },
      )
      .toMatch(/^\[exit 0 · [^\]]+\]\nharness-e2e/u);
  } finally {
    await launched.app.close().catch(() => undefined);
    await launched.fakeModel.stop().catch(() => undefined);
    await rm(launched.root, { recursive: true, force: true }).catch(() => undefined);
  }
});
