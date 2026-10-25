import { expect, startHost, test } from "./fixtures.ts";

/**
 * PRSLOY: an Agent Host crash restarts the host by itself on the same session file and
 * says so once («Агент перезапущен после сбоя — разговор сохранён»).
 */
test("host crash → automatic restart on the same session + one quiet notice", async ({ page }) => {
  await startHost(page);
  await page.getByTestId("prompt-input").fill("Before the crash.");
  await page.getByTestId("send-prompt").click();
  await expect(page.getByTestId("host-status").first()).toContainText("Agent settled", {
    timeout: 60_000,
  });
  const before = await page.getByTestId("runtime-snapshot").first().innerText();
  const sessionFile = /"sessionFile":\s*"([^"]+)"/.exec(before)?.[1];
  const runtimeId = /"runtimeId":\s*"([^"]+)"/.exec(before)?.[1];
  expect(sessionFile).toBeTruthy();

  await page.getByTestId("developer-summary").click();
  await page.getByTestId("crash-host").click({ force: true });

  // No user action: the host comes back by itself.
  await expect(page.getByTestId("prsloy-host-recovered")).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => page.getByTestId("runtime-snapshot").first().innerText(), {
      timeout: 30_000,
    })
    .toMatch(/"runtimeId":/);
  const after = await page.getByTestId("runtime-snapshot").first().innerText();
  expect(/"runtimeId":\s*"([^"]+)"/.exec(after)?.[1]).not.toBe(runtimeId);
  expect(/"sessionFile":\s*"([^"]+)"/.exec(after)?.[1]).toBe(sessionFile);
});
