/**
 * #83 end to end: the agent asks a real `ask_user` question with four options, the user
 * picks one, and the choice comes back to the agent as the tool result.
 *
 * This is the whole point of the fix: a question must be visible *and* answerable. When
 * either half was broken the agent stayed blocked and the app looked busy forever.
 */
import { expect, launchZenoApp, startHost, test } from "./fixtures.ts";

const QUESTION = "Что именно не так в чате на экране?";
const OPTIONS = ["Вёрстка поехала", "Картинка мелкая", "Две кнопки", "Другое"];

test("ask_user question is shown and the answer reaches the agent", async () => {
  const launched = await launchZenoApp({
    tools: "read,ask_user",
    toolCall: {
      name: "ask_user",
      arguments: { question: QUESTION, options: OPTIONS, recommended: OPTIONS[0] },
    },
  });
  try {
    const { page } = launched;
    await startHost(page);
    await page.getByTestId("prompt-input").fill("Use the tool please.");
    await page.getByTestId("send-prompt").click();

    const dialog = page.getByTestId("extension-ui-select-dialog");
    await expect(dialog).toBeVisible({ timeout: 45_000 });
    await expect(page.getByTestId("extension-ui-select-title")).toContainText(QUESTION);
    // Every option the agent offered is choosable, plus «your own answer» and «you choose».
    for (let index = 0; index < OPTIONS.length; index += 1) {
      await expect(page.getByTestId(`extension-ui-select-option-${index}`)).toContainText(
        OPTIONS[index]!,
      );
    }

    await page.getByTestId("extension-ui-select-option-1").click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    // The chosen option must arrive at the model as the tool result — not just close a window.
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
