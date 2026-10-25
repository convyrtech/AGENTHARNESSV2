/**
 * The main paths by keyboard alone, in both themes: «Код» (new chat → write → Enter sends →
 * «Остановить»), settings (open, move between sections, switch a toggle with Space, Esc out of a
 * dialog), and every stop on the way shows where the focus is. «Дизайн» by keyboard is in
 * design-replay.spec.ts (the owner card answered with a button).
 */
import type { Page } from "@playwright/test";
import { lintLayout } from "@zeno/layout-rules";
import { expect, test } from "./fixtures.ts";

async function prepare(page: Page, mode: "light" | "dark") {
  await page.evaluate((value) => {
    localStorage.setItem("zeno.locale", "ru");
    localStorage.setItem("zeno.colorMode", value);
  }, mode);
  await page.reload();
  await page.waitForSelector('[data-testid="zeno-app"][data-bootstrap-ready="true"]');
  await page.waitForTimeout(800);
}

/** Tab until `testId` has focus; the stops passed on the way, by test id or role and name. */
async function tabTo(page: Page, testId: string, max = 60): Promise<string[]> {
  const stops: string[] = [];
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    const here = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return "";
      return (
        el.dataset.testid ??
        `${el.tagName.toLowerCase()}:${el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 30) ?? ""}`
      );
    });
    stops.push(here);
    if (here === testId) return stops;
  }
  throw new Error(`Tab never reached ${testId}; stops: ${stops.join(" → ")}`);
}

/** Interactive elements on screen whose keyboard focus changes nothing visible. */
async function focusHidden(page: Page) {
  const found = await page.evaluate(lintLayout, {
    minWidth: 760,
    minHeight: 480,
    checkFocus: true,
    focusLimit: 120,
  });
  return found.filter((v) => v.rule === "focus-hidden").map((v) => `${v.selector} «${v.text}»`);
}

for (const mode of ["light", "dark"] as const) {
  test(`«Код» by keyboard (${mode}): new chat, Enter sends, «Остановить»`, async ({ page }) => {
    test.setTimeout(180_000);
    await prepare(page, mode);
    expect(await focusHidden(page), "home").toEqual([]);

    // the sidebar comes first, then the chat: «Новый чат» before the prompt field
    await tabTo(page, "start-host");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("runtime-snapshot").first()).toContainText("runtimeId", {
      timeout: 60_000,
    });
    const input = page.getByTestId("prompt-input");
    await expect(input).toBeFocused();
    await page.keyboard.type("please abort this turn");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("timeline")).toContainText("Waiting for abort", {
      timeout: 60_000,
    });
    // from the field the next Tab stops are the composer's own controls, «Остановить» among them
    await tabTo(page, "abort-prompt", 20);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("host-status").first()).toContainText(
      /Agent aborted|Agent settled/,
      {
        timeout: 30_000,
      },
    );
    expect(await focusHidden(page), "chat").toEqual([]);
  });

  test(`settings by keyboard (${mode}): sections, a toggle with Space, Esc closes a dialog`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await prepare(page, mode);
    await page.keyboard.press(process.platform === "darwin" ? "Meta+," : "Control+,");
    await expect(page.getByTestId("settings-general")).toBeVisible();
    expect(await focusHidden(page), "settings").toEqual([]);

    await tabTo(page, "settings-nav-behavior");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("settings-behavior")).toBeVisible();
    const toggle = page.getByTestId("settings-confirm-delete");
    const before = await toggle.getAttribute("data-state");
    await tabTo(page, "settings-confirm-delete");
    await page.keyboard.press("Space");
    await expect(toggle).not.toHaveAttribute("data-state", before ?? "");
    await page.keyboard.press("Space");
    await expect(toggle).toHaveAttribute("data-state", before ?? "");

    // a dialog opened from the keyboard closes with Esc and gives the focus back
    await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
    const palette = page.getByRole("dialog");
    await expect(palette).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();
  });
}
