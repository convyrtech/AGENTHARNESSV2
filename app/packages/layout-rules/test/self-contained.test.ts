import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vite-plus/test";
import { lintLayout, type LayoutViolation, type LintOptions } from "../src/index.ts";

/** The smallest DOM the function touches on an empty page: a bare <html> with an empty <body>. */
function emptyPage(width: number, height: number) {
  const box = { left: 0, top: 0, right: width, bottom: height, width, height };
  const html = {
    tagName: "HTML",
    clientWidth: width,
    clientHeight: height,
    scrollWidth: width,
    parentElement: null,
    innerText: "",
    getAttribute: () => null,
    getBoundingClientRect: () => box,
  };
  return {
    window: { innerWidth: width, innerHeight: height },
    document: {
      documentElement: html,
      scrollingElement: html,
      body: { querySelectorAll: () => [] },
    },
    Node: { TEXT_NODE: 3 },
    SVGElement: class {},
    getComputedStyle: () => ({}),
  };
}

/** Runs the function from its source alone, the way the harness ships it into a page. */
function runFromSource(page: object, options: LintOptions): LayoutViolation[] {
  const context = { ...page, options };
  (context as Record<string, unknown>).window = {
    ...(page as { window: object }).window,
  };
  return runInNewContext(`(${lintLayout.toString()})(options)`, context) as LayoutViolation[];
}

describe("lintLayout source", () => {
  it("runs from its own source text with nothing from this module in scope", () => {
    const options = { minWidth: 760, minHeight: 480, checkFocus: false };
    expect(runFromSource(emptyPage(1366, 768), options)).toEqual([]);
  });

  it("reports a window below the minimum from that source", () => {
    const options = { minWidth: 760, minHeight: 480, checkFocus: false };
    const found = runFromSource(emptyPage(700, 400), options);
    expect(found.map((v) => v.rule)).toEqual(["window-min"]);
    expect(found[0]!.detail).toContain("700×400");
  });
});
