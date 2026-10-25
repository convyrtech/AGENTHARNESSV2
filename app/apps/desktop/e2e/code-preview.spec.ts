import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, launchZenoApp, sendPrompt, startHost, test, waitSettled } from "./fixtures.ts";

/**
 * «Код» preview end to end: the agent writes a page with the real write tool, the finished
 * turn offers «Открыть превью», the page opens in the sandboxed side panel from the
 * loopback server, and links inside it cannot take the frame anywhere else.
 */
const PAGE = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>Визитка</title></head>
<body>
  <h1>Анна Смирнова</h1>
  <a id="away" href="https://example.com/">наружу</a>
  <a id="localhost" href="http://localhost:9/">localhost</a>
  <a id="otherport" href="http://127.0.0.1:9/">other port</a>
</body></html>
`;

test("a written page opens in the sandboxed preview and stays on loopback", async () => {
  const launched = await launchZenoApp({
    tools: "read,write",
    toolCall: { name: "write", arguments: { path: "site/index.html", content: PAGE } },
  });
  try {
    const { page } = launched;
    await writeFile(join(launched.workspace, ".env"), "PRSLOY_TEST_SECRET=1\n");
    await startHost(page);
    await sendPrompt(page, "Use the tool to write the page.");
    await waitSettled(page);

    await page.getByTestId("turn-preview-btn").click();
    const panel = page.getByTestId("code-preview-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("index.html");
    const frameEl = page.getByTestId("code-preview-frame");
    await expect(frameEl).toHaveAttribute("src", /^http:\/\/127\.0\.0\.1:\d+\/site\/index\.html$/);
    await expect(frameEl).toHaveAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
    const frame = page.frameLocator('[data-testid="code-preview-frame"]');
    await expect(frame.getByRole("heading", { name: "Анна Смирнова" })).toBeVisible();

    // Two layers keep the frame on loopback. Main's guard cancels a navigation to a port
    // nobody opened (the window CSP would allow it), so the page simply stays…
    const previewUrl = () =>
      page
        .frames()
        .find((f) => f !== page.mainFrame() && f.url().startsWith("http"))
        ?.url();
    const start = previewUrl();
    expect(start).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/site\/index\.html$/);
    await frame.locator("#otherport").click();
    await page.waitForTimeout(800);
    expect(previewUrl()).toBe(start);
    await expect(frame.getByRole("heading", { name: "Анна Смирнова" })).toBeVisible();
    // …and the CSP's frame-src refuses any other host outright; «Обновить» brings the page back.
    for (const id of ["#away", "#localhost"]) {
      await frame.locator(id).click();
      await page.waitForTimeout(800);
      expect(page.frames().map((f) => f.url())).not.toContainEqual(
        expect.stringMatching(/example\.com|localhost/),
      );
      await page.getByTestId("code-preview-reload").click();
      await expect(frame.getByRole("heading", { name: "Анна Смирнова" })).toBeVisible();
      expect(previewUrl()).toBe(start);
    }

    // The project's dotfiles are never served, even to a direct request.
    const env = await fetch(new URL("/.env", start ?? "").toString());
    expect(env.status).toBe(404);
    expect(await env.text()).not.toContain("PRSLOY_TEST_SECRET");

    await page.getByTestId("code-preview-device-phone").click();
    await expect(page.locator(".code-preview-stage")).toHaveAttribute("data-device", "phone");
    await page.getByTestId("code-preview-close").click();
    await expect(panel).toBeHidden();
  } finally {
    await launched.app.close().catch(() => undefined);
    await launched.fakeModel.stop().catch(() => undefined);
    await rm(launched.root, { recursive: true, force: true }).catch(() => undefined);
  }
});
