/**
 * Small windows and big system scaling, where ci's layout lint found real bugs: at about 760 CSS
 * px of content «Вернуть по умолчанию» was clipped and «Адрес сервера» ran into its field; the
 * agent status line was 10 px and English; the prompt field had no visible focus and an English
 * name. System scaling keeps CSS px equal to window DIPs, so a screen at 175 % is a smaller
 * window here: 1366×768 @175 % is 780×439 DIP, held at the window minimum of 760×480.
 */
import type { ElectronApplication, Page } from "playwright";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures.ts";

/** LAYOUT_SHOTS=before|after saves each checked state into docs/prsloy/screens/layout-*. */
const SHOTS = process.env.LAYOUT_SHOTS;
const screens = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "docs",
  "prsloy",
  "screens",
);
async function shot(app: ElectronApplication, name: string) {
  if (!SHOTS) return;
  // the whole window as drawn, zoom included (a page screenshot is cut to the CSS viewport)
  const png = await app.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG().toString("base64"),
  );
  await writeFile(join(screens, `layout-${name}-${SHOTS}.png`), Buffer.from(png, "base64"));
}

const SIZES = [
  { name: "800x600", width: 800, height: 600 },
  { name: "1366x768-175", width: 780, height: 480 },
  { name: "window-minimum", width: 760, height: 480 },
] as const;

async function resize(app: ElectronApplication, page: Page, size: (typeof SIZES)[number]) {
  await page.evaluate(() => localStorage.setItem("zeno.locale", "ru"));
  await page.reload();
  await page.waitForSelector('[data-testid="zeno-app"][data-bootstrap-ready="true"]');
  await app.evaluate(({ BrowserWindow }, { width, height }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(width, height);
  }, size);
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(size.width);
}

/** Elements whose text is cut: wider content than box, or sticking out of their row. */
function clipped(page: Page, selector: string) {
  return page.locator(selector).evaluateAll((elements) =>
    elements
      .filter((el) => {
        const box = el.getBoundingClientRect();
        const row = el.closest(".settings-row")?.getBoundingClientRect();
        return (
          el.scrollWidth > el.clientWidth + 1 || (row !== undefined && box.right > row.right + 1)
        );
      })
      .map((el) => el.textContent ?? ""),
  );
}

function overlaps(a: DOMRect | null, b: DOMRect | null) {
  if (!a || !b) return false;
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

for (const size of SIZES) {
  test(`settings › account at ${size.name}: nothing clipped or overlapping`, async ({
    page,
    zeno,
  }) => {
    await resize(zeno.app, page, size);
    await page.evaluate(() => window.zeno.prsloy.setBaseUrl("http://127.0.0.1:9/v1"));
    await page.keyboard.press(process.platform === "darwin" ? "Meta+," : "Control+,");
    await page.getByTestId("settings-nav-account").click();
    const reset = page.getByRole("button", { name: "Вернуть по умолчанию" });
    await expect(reset).toBeVisible();
    await shot(zeno.app, `account-${size.name}`);
    expect(await clipped(page, '[data-testid="settings-account-key"] button')).toEqual([]);
    const row = page
      .locator(".settings-row")
      .filter({ has: page.getByTestId("settings-account-url") });
    const title = await row
      .locator(".settings-row-title")
      .evaluate((el) => el.getBoundingClientRect());
    const field = await page
      .getByTestId("settings-account-url")
      .evaluate((el) => el.getBoundingClientRect());
    expect(overlaps(title, field)).toBe(false);
  });
}

test("the agent status line is readable and Russian; the prompt field shows focus", async ({
  page,
  zeno,
}) => {
  await resize(zeno.app, page, SIZES[2]);
  const input = page.getByTestId("prompt-input");
  await input.focus();
  await shot(zeno.app, "prompt-focus");
  const card = page.locator(".composer-card").first();
  const ring = await card.evaluate((el) => {
    const style = getComputedStyle(el);
    return { outline: style.outlineStyle, shadow: style.boxShadow };
  });
  expect(ring.outline !== "none" || ring.shadow.includes("rgb")).toBe(true);
  await expect(input).toHaveAttribute("aria-label", "Сообщение агенту");

  // (before the fix the visible line itself carried the test id)
  const status = page
    .locator('[data-testid="host-status-pill"], [data-testid="host-status"]:visible')
    .first();
  await page.getByTestId("developer-summary").click();
  await expect(status).toBeVisible();
  await shot(zeno.app, "host-status");
  expect(
    Number.parseFloat(await status.evaluate((el) => getComputedStyle(el).fontSize)),
  ).toBeGreaterThanOrEqual(12);
  await expect(status).not.toContainText(/[a-z]{3}/iu);
});
