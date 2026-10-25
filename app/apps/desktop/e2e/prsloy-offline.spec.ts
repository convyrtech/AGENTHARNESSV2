import { expect, startHost, test } from "./fixtures.ts";

/**
 * PRSLOY: gateway unreachable → the failed turn's event carries a stable code ("network"),
 * which the ui's Russian error card («Нет связи с сервером», «Повторить») keys on.
 */
test("gateway unreachable: message.failed carries code network", async ({ page, zeno }) => {
  await startHost(page);
  await zeno.fakeModel.stop();
  await page.getByTestId("prompt-input").fill("Hello while offline.");
  await page.getByTestId("send-prompt").click();
  await expect
    .poll(async () => page.getByTestId("event-log").first().innerText(), { timeout: 90_000 })
    .toMatch(
      /message\.failed[\s\S]*"code":\s*"network"|"code":\s*"network"[\s\S]*message\.failed/u,
    );
});
