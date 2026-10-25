import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, launchZenoApp, startHost, test } from "./fixtures.ts";
import { longSessionJsonl } from "./long-session.ts";

/**
 * PRSLOY stage 7b — long chat measurement (opt-in: PRSLOY_PERF=1, PRSLOY_PERF_TURNS=500).
 * A generated session of N turns (prompt, bash call with ~4 KB output, ~1 KB markdown
 * reply) is opened from the sidebar; records open time, process memory, DOM size and
 * frame times while scrolling the whole timeline. Prints `[perf] {json}`.
 */
const TURNS = Number(process.env.PRSLOY_PERF_TURNS ?? 500);
const LAST_MARKER = `Ход ${TURNS}: покажи файлы`;

test("long chat: open, memory, scroll", async () => {
  test.skip(process.env.PRSLOY_PERF !== "1", "measurement, opt-in (PRSLOY_PERF=1)");
  test.setTimeout(600_000);
  const launched = await launchZenoApp();
  const sessionPath = join(launched.agentDir, "sessions", "long-chat.jsonl");
  const jsonl = longSessionJsonl(launched.workspace, TURNS);
  try {
    const { page, app } = launched;
    await startHost(page);
    await mkdir(join(launched.agentDir, "sessions"), { recursive: true });
    await writeFile(sessionPath, jsonl);
    await page.reload();
    await startHost(page);
    const metrics = async () =>
      app.evaluate(({ app: a }) =>
        a
          .getAppMetrics()
          .map((m) => ({ type: m.type, name: m.name ?? "", kb: m.memory.workingSetSize })),
      );
    const before = await metrics();
    const row = page.locator(`[data-session-path$="long-chat.jsonl"]`).first();
    await expect(row).toBeVisible({ timeout: 60_000 });
    await page.evaluate(() => {
      const w = window as unknown as { __longTasks: number[] };
      w.__longTasks = [];
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) w.__longTasks.push(Math.round(e.duration));
      }).observe({ type: "longtask", buffered: false });
    });
    const t0 = Date.now();
    await row.click();
    await expect(page.getByTestId("timeline")).toContainText(LAST_MARKER, { timeout: 120_000 });
    const openMs = Date.now() - t0;
    const longTasks = await page.evaluate(
      () => (window as unknown as { __longTasks: number[] }).__longTasks,
    );
    await page.waitForTimeout(1500);
    const after = await metrics();
    const dom = await page.evaluate(() => ({
      nodes: document.getElementsByTagName("*").length,
      heapMb: Math.round(
        ((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
          ?.usedJSHeapSize ?? 0) / 1e6,
      ),
    }));
    // Scroll the whole timeline top ↔ bottom in steps, recording frame gaps.
    const scroll = await page.evaluate(async () => {
      const candidates = [...document.querySelectorAll<HTMLElement>("*")].filter(
        (el) =>
          el.scrollHeight > el.clientHeight + 200 &&
          /auto|scroll/u.test(getComputedStyle(el).overflowY),
      );
      const el = candidates.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
      if (!el) return { error: "no scroller" };
      const frames: number[] = [];
      let last = performance.now();
      let running = true;
      const tick = (now: number) => {
        frames.push(now - last);
        last = now;
        if (running) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      const steps = 120;
      const height = el.scrollHeight;
      for (let i = 0; i <= steps; i++) {
        el.scrollTop = height - (height * i) / steps;
        await new Promise((r) => requestAnimationFrame(() => r(undefined)));
      }
      running = false;
      const sorted = [...frames].sort((a, b) => a - b);
      return {
        scrollHeight: height,
        frames: frames.length,
        p50: Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0),
        p95: Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
        max: Math.round(sorted.at(-1) ?? 0),
        over50ms: frames.filter((f) => f > 50).length,
      };
    });
    const sum = (m: { type: string; kb: number }[], type: string) =>
      Math.round(m.filter((x) => x.type === type).reduce((s, x) => s + x.kb, 0) / 1024);
    const report = {
      turns: TURNS,
      sessionMb: Math.round(jsonl.length / 1e5) / 10,
      openMs,
      rendererLongTasksMs: longTasks,
      memoryMb: {
        mainBefore: sum(before, "Browser"),
        mainAfter: sum(after, "Browser"),
        rendererBefore: sum(before, "Tab"),
        rendererAfter: sum(after, "Tab"),
        hostAfter: sum(after, "Utility"),
      },
      dom,
      scroll,
    };
    console.log(`[perf] ${JSON.stringify(report)}`);
  } finally {
    await launched.app.close().catch(() => undefined);
    await launched.fakeModel.stop().catch(() => undefined);
    await rm(launched.root, { recursive: true, force: true }).catch(() => undefined);
  }
});
