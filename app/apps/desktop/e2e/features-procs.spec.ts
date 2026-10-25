import { expect, sendPrompt, startHost, test, waitSettled } from "./fixtures.ts";
import { closeLaunched, launchRu, shot } from "./features-helpers.ts";

/**
 * «Бот работает · Остановить · Журнал» (research/19 §1.10): the harness's real
 * `bash_background` starts a stand-in Telegram bot; the chat shows «Бот Telegram ·
 * работает …», «Журнал» shows its lines as they come, «Остановить» ends the process tree
 * (main checks it is our host's child first).
 */
const BOT = `i=0; while true; do i=$((i+1)); echo "telegram bot: сообщение $i"; sleep 0.3; done`;

test.skip(process.platform === "win32", "the stand-in bot is a POSIX shell loop");

test("a background bot shows as running, its log updates, «Остановить» ends it", async () => {
  const launched = await launchRu({
    tools: "read,bash,bash_background",
    toolCall: { name: "bash_background", arguments: { command: BOT, wait_seconds: 1 } },
  });
  try {
    const { page } = launched;
    await startHost(page);
    await sendPrompt(page, "Use the tool to start the bot.");
    await waitSettled(page);
    const row = page.getByTestId("agent-proc");
    await expect(row).toContainText("Бот Telegram");
    await expect(row.getByTestId("agent-proc-status")).toContainText("работает");
    await shot(page, "procs-1-running");

    await row.getByTestId("agent-proc-log-toggle").click();
    const log = row.getByTestId("agent-proc-log");
    await expect(log).toContainText("telegram bot: сообщение");
    const first = (await log.textContent()) ?? "";
    // Refreshed while open: new lines arrive.
    await expect
      .poll(async () => (await log.textContent()) ?? "", { timeout: 10_000 })
      .not.toBe(first);
    await shot(page, "procs-2-log");

    // The pid the harness reported to the model («bg1: работает, pid N»).
    const pid = Number(/pid (\d+)/u.exec(JSON.stringify(launched.fakeModel.requests))?.[1]);
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).not.toThrow();
    await row.getByTestId("agent-proc-stop").click();
    await expect(row.getByTestId("agent-proc-status")).toHaveText("остановлен");
    expect(() => process.kill(pid, 0)).toThrow();
    // The log stops growing: the loop is gone with its shell.
    await page.waitForTimeout(2500);
    const a = (await log.textContent()) ?? "";
    await page.waitForTimeout(2500);
    expect((await log.textContent()) ?? "").toBe(a);
    await shot(page, "procs-3-stopped");
  } finally {
    await closeLaunched(launched);
  }
});
