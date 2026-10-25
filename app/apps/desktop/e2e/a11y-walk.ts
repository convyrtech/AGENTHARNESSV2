/**
 * Keyboard and axe helpers for the key-screen pass (research/28 §4 item 3): walk the Tab order and
 * say where focus went, whether it showed, and whether it got stuck; axe with serious and critical
 * issues only.
 */
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { lintLayout } from "@zeno/layout-rules";

export type Stop = { id: string; visible: boolean };

/** The focused element as a readable id: test id, else tag and its name. */
export async function focusedId(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return "body";
    const name = el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 30) ?? "";
    return el.dataset.testid ?? `${el.tagName.toLowerCase()}:${name}`;
  });
}

/**
 * Tab `count` times from where focus is (Shift+Tab with `back`). Each stop: its id and whether the
 * focus is drawn (an outline, a ring or a changed border/background, as layout-rules checks it).
 */
export async function walkTab(page: Page, count: number, back = false): Promise<Stop[]> {
  const stops: Stop[] = [];
  for (let i = 0; i < count; i++) {
    await page.keyboard.press(back ? "Shift+Tab" : "Tab");
    const id = await focusedId(page);
    const visible = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return true;
      const cs = getComputedStyle(el);
      const outline = cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0;
      const ring = cs.boxShadow !== "none" && cs.boxShadow !== "";
      return outline || ring || el.matches(":focus-visible:is([data-focus-ring])");
    });
    stops.push({ id, visible });
  }
  return stops;
}

/** Tab until `testId` has focus, or fail with the stops passed on the way. */
export async function tabTo(page: Page, testId: string, max = 80): Promise<Stop[]> {
  const stops: Stop[] = [];
  for (let i = 0; i < max; i++) {
    const [stop] = await walkTab(page, 1);
    stops.push(stop!);
    if (stop!.id === testId) return stops;
  }
  throw new Error(`Tab never reached ${testId}: ${stops.map((s) => s.id).join(" → ")}`);
}

/** Controls on screen whose focus changes nothing visible (layout-rules «focus-hidden»). */
export async function focusHidden(page: Page): Promise<string[]> {
  const found = await page.evaluate(lintLayout, {
    minWidth: 760,
    minHeight: 480,
    checkFocus: true,
    focusLimit: 160,
  });
  return found.filter((v) => v.rule === "focus-hidden").map((v) => `${v.selector} «${v.text}»`);
}

/** axe (WCAG A/AA), serious and critical issues only. */
export async function axeSerious(page: Page, include?: string): Promise<string[]> {
  let builder = new AxeBuilder({ page })
    .setLegacyMode(true)
    .withTags(["wcag2a", "wcag2aa"])
    .exclude('[data-testid="runtime-snapshot"]');
  if (include) builder = builder.include(include);
  const result = await builder.analyze();
  type Node = { html: string; failureSummary?: string };
  return result.violations
    .filter((v: { impact?: string | null }) => v.impact === "serious" || v.impact === "critical")
    .flatMap((v: { id: string; nodes: Node[] }) =>
      v.nodes.slice(0, 4).map((n) => `${v.id}: ${n.html.slice(0, 140)}`),
    );
}
