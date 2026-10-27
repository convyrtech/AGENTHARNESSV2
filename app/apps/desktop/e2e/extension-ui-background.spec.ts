/**
 * #83: a question asked by a chat the user has already left behind.
 *
 * The agent asks, the user switches to another conversation, and the asking chat is parked
 * in the background. Before the fix the question was dropped in the main process and the
 * answer was rejected as stale, so the agent stayed blocked with nothing on screen — the
 * «nothing happens» hang from the issue. Now the question is shown whichever chat is open,
 * and the answer travels back to the agent that asked.
 */
import { expect, launchZenoApp, startHost, test } from "./fixtures.ts";

const QUESTION = "Фон: что не так в чате?";
const OPTIONS = ["Первый вариант", "Второй вариант", "Третий вариант"];

test("a question from a background chat is shown and answered", async () => {
  test.setTimeout(180_000);
  const launched = await launchZenoApp({
    tools: "read,ask_user",
    toolCall: {
      name: "ask_user",
      arguments: { question: QUESTION, options: OPTIONS, recommended: OPTIONS[0] },
    },
  });
  const { page } = launched;
  try {
    await startHost(page);
    await page.getByTestId("prompt-input").fill("Use the tool please.");
    await page.getByTestId("send-prompt").click();

    // Leave the asking chat: it becomes a parked, background host.
    const askingRuntime = /"runtimeId":\s*"([^"]+)"/.exec(
      await page.getByTestId("runtime-snapshot").first().innerText(),
    )?.[1];
    expect(askingRuntime).toBeTruthy();
    await page.getByTestId("start-host").click({ force: true });

    const dialog = page.getByTestId("extension-ui-select-dialog");
    await expect(dialog).toBeVisible({ timeout: 45_000 });
    await expect(page.getByTestId("extension-ui-select-title")).toContainText(QUESTION);

    await page.getByTestId("extension-ui-select-option-1").click();
    await expect(dialog).toBeHidden({ timeout: 20_000 });

    // The answer reached the agent that asked, in the chat that is no longer on screen.
    await expect
      .poll(
        () =>
          JSON.stringify(
            launched.fakeModel.requests
              .flatMap((request) => request.messages ?? [])
              .filter((message) => message.role === "tool")
              .map((message) => message.content),
          ),
        { timeout: 30_000 },
      )
      .toContain(OPTIONS[1]);
  } finally {
    await launched.app.close().catch(() => undefined);
    await launched.fakeModel.stop().catch(() => undefined);
  }
});
