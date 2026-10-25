import { expect, test } from "./fixtures.ts";
import { closeLaunched, launchRu, shot } from "./features-helpers.ts";

/**
 * Settings → Питомец (layout-lint report): with the keyboard, the tile you stand on must
 * look different from the tile you chose, and the colours have Russian names.
 * `FEATURES_SHOT=before` names the screenshot for a run on the old code.
 */
test("pet tiles: a separate focus ring, colours in Russian", async () => {
  const launched = await launchRu();
  try {
    const { page } = launched;
    await page.getByTestId("nav-settings").click();
    await page.getByTestId("settings-nav-pet").click();
    const chosen = page.locator('.pet-settings-grid__btn[aria-pressed="true"]').first();
    await expect(chosen).toBeVisible();
    await chosen.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(chosen).toBeFocused();
    await shot(page, `pet-focus-${process.env.FEATURES_SHOT ?? "after"}`);
    if (process.env.FEATURES_SHOT === "before") return;

    const ring = (el: Element) => {
      const s = getComputedStyle(el);
      return `${s.outlineStyle} ${s.outlineWidth} ${s.boxShadow}`;
    };
    // Chosen and focused: dashed ring. Chosen only: no ring, the inner frame stays.
    const focused = await chosen.evaluate(ring);
    expect(focused).toContain("dashed");
    await page.keyboard.press("Tab");
    const unfocused = await chosen.evaluate(ring);
    expect(unfocused).not.toContain("dashed");
    expect(unfocused).toContain("inset");
    // The next tile now has the ring though it is not chosen.
    const next = page.locator(".pet-settings-grid__btn:focus-visible");
    await expect(next).toHaveAttribute("aria-pressed", "false");

    await expect(page.getByRole("button", { name: "Чёрный" }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Black" })).toHaveCount(0);
  } finally {
    await closeLaunched(launched);
  }
});
