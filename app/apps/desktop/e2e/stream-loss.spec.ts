import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, sendPrompt, startHost, test } from "./fixtures.ts";
import { closeLaunched, launchRu, shot } from "./features-helpers.ts";

/**
 * #79: a turn after switching chats away and back must show its reply, one chat's text
 * must never appear in another, and a reply cut off at the model's length limit shows an
 * error card instead of looking finished.
 *
 * The fake model answers each prompt with a unique marker; nothing leaves the machine.
 */
const MARK_A = "МАРКЕР_АЛЬФА";
const MARK_B = "МАРКЕР_БЕТА";
const MARK_C = "МАРКЕР_ГАММА";

function scriptedReply(lastUserText: string): string | undefined {
  if (lastUserText.includes("первый вопрос")) return `Ответ первого диалога: ${MARK_A}.`;
  if (lastUserText.includes("второй вопрос")) return `Ответ второго диалога: ${MARK_B}.`;
  if (lastUserText.includes("третий вопрос")) return `Ответ после возврата: ${MARK_C}.`;
  if (lastUserText.includes("обрежь ответ")) return "Длинный ответ оборвался на половине фразы.";
  return undefined;
}

test("switching chats does not eat or mix answers; a truncated reply warns (#79)", async () => {
  const launched = await launchRu({
    reply: scriptedReply,
    truncatedWhenPromptIncludes: "обрежь ответ",
  });
  try {
    const { page } = launched;
    const timeline = page.getByTestId("timeline");

    await startHost(page);
    await sendPrompt(page, "первый вопрос");
    await expect(timeline).toContainText(MARK_A);

    // A second conversation: its answer must not contain the first chat's marker.
    await page.getByTestId("start-host").click({ force: true });
    // Wait for the fresh host like startHost() does — sending into "Creating conversation…"
    // would be rejected with "Agent Host is not ready".
    await expect(page.getByTestId("host-status").first()).toContainText(
      /Agent Host ready|Начните разговор/,
      { timeout: 60_000 },
    );
    await expect(page.getByTestId("empty-hero")).toBeVisible({ timeout: 30_000 });
    await sendPrompt(page, "второй вопрос");
    await expect(timeline).toContainText(MARK_B);
    expect(await timeline.textContent()).not.toContain(MARK_A);

    // Back to the first conversation, then a new turn there (#79 regression: the reply
    // used to vanish — the host restarted its event numbering and the renderer's stale
    // dedupe list ate every event of the turn).
    await page
      .getByTestId("conversations-list")
      .locator('button[data-active="false"]')
      .filter({ hasText: "первый вопрос" })
      .first()
      .click();
    await expect(timeline).toContainText(MARK_A);
    expect(await timeline.textContent()).not.toContain(MARK_B);
    await sendPrompt(page, "третий вопрос");
    await expect(timeline).toContainText(MARK_C);
    expect(await timeline.textContent()).not.toContain(MARK_B);
    await shot(page, "79-after-switch-back");

    // The saved history is isolated too, not just the screen: each chat's own session file
    // holds only its own markers.
    const sessionsDir = join(launched.agentDir, "sessions");
    const files = (await readdir(sessionsDir, { recursive: true })).filter((name) =>
      String(name).endsWith(".jsonl"),
    );
    const bodies: string[] = [];
    for (const name of files) {
      bodies.push(await readFile(join(sessionsDir, String(name)), "utf8"));
    }
    const withAlpha = bodies.filter((body) => body.includes(MARK_A));
    const withBeta = bodies.filter((body) => body.includes(MARK_B));
    expect(withAlpha).toHaveLength(1);
    expect(withBeta).toHaveLength(1);
    // The short answer that starts like the longer one survived on disk (prefix bug, #79).
    expect(withAlpha[0]).toContain(MARK_C);
    expect(withAlpha[0]).not.toContain(MARK_B);
    expect(withBeta[0]).not.toContain(MARK_A);

    // A reply cut off at the model's length limit shows an error card, not silence.
    await sendPrompt(page, "обрежь ответ");
    await expect(timeline).toContainText("Длинный ответ оборвался");
    await expect(timeline).toContainText("Ответ обрезан");
    await shot(page, "79-truncated-card");
  } finally {
    await closeLaunched(launched);
  }
});

test("a switch in the middle of a stream and a restart keep every answer in its own chat (#79)", async () => {
  const reply = (lastUserText: string) => {
    if (lastUserText.includes("первый вопрос")) return `Ответ первого диалога: ${MARK_A}.`;
    if (lastUserText.includes("второй вопрос")) return `Ответ второго диалога: ${MARK_B}.`;
    return undefined;
  };
  // 1.5 s between chunks: the answer is still streaming while the chats are switched.
  const first = await launchRu({ reply, streamDelayMs: 1500 });
  try {
    const { page } = first;
    const timeline = page.getByTestId("timeline");
    const openChat = (title: string) =>
      page
        .getByTestId("conversations-list")
        .locator('button[data-active="false"]')
        .filter({ hasText: title })
        .first()
        .click();

    await startHost(page);
    await sendPrompt(page, "первый вопрос");
    await expect(timeline).toContainText(MARK_A);

    // A second chat of the same project.
    await page.getByTestId("start-host").click({ force: true });
    // Sending into "Creating conversation…" is rejected with "Agent Host is not ready".
    await expect(page.getByTestId("host-status").first()).toContainText(
      /Agent Host ready|Начните разговор/,
      { timeout: 60_000 },
    );
    await expect(page.getByTestId("empty-hero")).toBeVisible({ timeout: 30_000 });
    await sendPrompt(page, "второй вопрос");
    await expect(timeline).toContainText(MARK_B);

    // A slow answer in the first chat, then switch away in the middle of it.
    await openChat("первый вопрос");
    await expect(timeline).toContainText(MARK_A);
    await sendPrompt(page, "stream slowly");
    await expect(timeline).toContainText("Waiting for abort");
    await openChat("второй вопрос");
    await expect(timeline).toContainText(MARK_B);

    // Late events of the parked turn must land in its own chat, never in this one.
    await page.waitForTimeout(6_000);
    const otherChat = await timeline.textContent();
    expect(otherChat).not.toContain("still streaming");
    // The parked turn's own question must not appear here either — the renderer used to
    // resolve a background turn's text against the open chat's question list (#79).
    expect(otherChat).not.toContain("stream slowly");
    expect(otherChat).not.toContain(MARK_A);

    // Coming back shows the parked turn whole: nothing was dropped while it streamed.
    await openChat("первый вопрос");
    await expect(timeline).toContainText("Waiting for abort");
    await expect(timeline).toContainText("still streaming");
    await expect(timeline).toContainText("done.");
    expect(await timeline.textContent()).not.toContain(MARK_B);
    await shot(page, "79-mid-stream-switch");
  } finally {
    await closeLaunched(first, { keepRoot: true });
  }

  // Restart on the same state: both chats come back from disk, each with its own text.
  const second = await launchRu({ reply, root: first.root });
  try {
    const { page } = second;
    const timeline = page.getByTestId("timeline");
    const openChat = (title: string) =>
      page
        .getByTestId("conversations-list")
        .locator('button[data-active="false"]')
        .filter({ hasText: title })
        .first()
        .click();
    await startHost(page);
    await openChat("первый вопрос");
    await expect(timeline).toContainText(MARK_A);
    await expect(timeline).toContainText("still streaming");
    expect(await timeline.textContent()).not.toContain(MARK_B);
    await openChat("второй вопрос");
    await expect(timeline).toContainText(MARK_B);
    const restored = await timeline.textContent();
    expect(restored).not.toContain(MARK_A);
    expect(restored).not.toContain("still streaming");
  } finally {
    await closeLaunched(second);
  }
});
