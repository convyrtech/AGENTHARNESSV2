/**
 * The layout rules on hand-made pages in a bare Electron window: each rule fires on its defect
 * and stays quiet on the intended look (ellipsis, line-clamp, data-clamp, scrolling boxes,
 * visually hidden text, a ring on a wrapper). Also the baseline matching.
 */
import { expect, test, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { excuse, parseBaseline } from "./layout-baseline.ts";
import { lintLayout, type LayoutRule } from "@zeno/layout-rules";

const require = createRequire(import.meta.url);
const electronBinary = require("electron") as string;

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "layout-rules-"));
  writeFileSync(
    join(dir, "main.cjs"),
    `const { app, BrowserWindow } = require("electron");
app.whenReady().then(() => {
  const win = new BrowserWindow({ useContentSize: true, width: 800, height: 600, minWidth: 760, minHeight: 480 });
  win.loadURL("about:blank");
});`,
  );
  writeFileSync(join(dir, "package.json"), '{"name":"layout-rules","main":"main.cjs"}');
  app = await electron.launch({ executablePath: electronBinary, args: [dir] });
  page = await app.firstWindow();
});

test.afterAll(async () => {
  await app?.close();
});

const CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/20px sans-serif; }
  button { width: 40px; height: 32px; border: 1px solid #888; background: #eee; }
  button:focus-visible { outline: 2px solid blue; }
`;

async function lint(body: string, extra = "", checkFocus = false) {
  await page.setContent(`<style>${CSS}${extra}</style>${body}`);
  return page.evaluate(lintLayout, { minWidth: 760, minHeight: 480, checkFocus });
}

const rules = (list: { rule: LayoutRule }[]) => list.map((v) => v.rule).sort();

test("a clean page has no violations", async () => {
  const v = await lint(
    `<main style="padding:20px">
       <h1>Заголовок</h1>
       <p>Текст и <a href="#x">ссылка в строке</a>.</p>
       <button>ОК</button> <button>Да</button>
       <div style="width:120px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">очень длинное название файла.txt</div>
       <div style="width:120px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">много строк текста, который режется на второй строке как задумано</div>
       <div data-clamp style="width:60px;height:20px;overflow:hidden">помечено как намеренное</div>
       <div style="height:60px;overflow:auto"><p>1</p><p>2</p><p>3</p><p>4</p></div>
       <span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">300 скрыто</span>
       <div class="ring" style="padding:4px"><input style="height:32px;outline:none"></div>
     </main>`,
    ".ring:focus-within { box-shadow: 0 0 0 2px blue; }",
    true,
  );
  expect(v).toEqual([]);
});

test("each defect is found", async () => {
  const v = await lint(
    `<div style="width:2000px;height:10px"></div>
     <div data-testid="clip" style="width:60px;height:20px;overflow:hidden;white-space:nowrap">обрезанный текст кнопки</div>
     <div style="position:absolute;left:100px;top:100px"><button data-testid="a">А</button></div>
     <div style="position:absolute;left:120px;top:110px"><button data-testid="b">Б</button></div>
     <button data-testid="tiny" style="position:absolute;left:300px;top:100px;width:16px;height:16px">x</button>
     <p style="font-size:10px;position:absolute;top:200px">мелко</p>`,
  );
  expect(rules(v)).toEqual(
    ["off-window", "overlap", "root-hscroll", "small-text", "target-size", "text-clipped"].sort(),
  );
  expect(v.find((x) => x.rule === "text-clipped")?.selector).toBe('[data-testid="clip"]');
  expect(v.find((x) => x.rule === "target-size")?.selector).toBe('[data-testid="tiny"]');
  expect(v.find((x) => x.rule === "overlap")?.detail).toContain('[data-testid="b"]');
});

test("text cut by a parent that hides overflow, but not by one that scrolls", async () => {
  const v = await lint(
    `<div style="width:200px;height:30px;overflow:hidden"><p data-testid="cut" style="margin:0;margin-top:20px">строка</p></div>
     <div style="width:200px;height:30px;overflow:auto"><p style="margin:0;margin-top:20px">прокрутка</p></div>`,
  );
  expect(v.map((x) => [x.rule, x.selector])).toEqual([["text-clipped", '[data-testid="cut"]']]);
});

test("a covered button is not an overlap; an invisible focus is reported", async () => {
  const v = await lint(
    `<button data-testid="under" style="position:absolute;left:10px;top:10px">под</button>
     <div style="position:fixed;inset:0;background:rgba(0,0,0,.4)">
       <button data-testid="modal" style="position:absolute;left:12px;top:12px">ОК</button>
     </div>
     <button data-testid="plain" class="no-ring" style="position:absolute;left:200px;top:200px">Б</button>`,
    ".no-ring:focus-visible { outline: none; }",
    true,
  );
  expect(v.map((x) => [x.rule, x.selector])).toEqual([["focus-hidden", '[data-testid="plain"]']]);
});

test("scrollsY: a page that scrolls down is not off-window below the fold, only sideways", async () => {
  const body = `<section data-testid="below" style="position:absolute;top:900px;width:200px;height:300px">ниже первого экрана</section>
     <div data-testid="wide" style="position:absolute;top:10px;left:600px;width:400px;height:20px">вбок</div>`;
  await page.setContent(`<style>${CSS}</style>${body}`);
  const site = await page.evaluate(lintLayout, {
    minWidth: 0,
    minHeight: 0,
    checkFocus: false,
    scrollsY: true,
  });
  expect(site.filter((v) => v.rule === "off-window").map((v) => v.selector)).toEqual([
    '[data-testid="wide"]',
  ]);
  const app = await page.evaluate(lintLayout, { minWidth: 0, minHeight: 0, checkFocus: false });
  expect(
    app
      .filter((v) => v.rule === "off-window")
      .map((v) => v.selector)
      .sort(),
  ).toEqual(['[data-testid="below"]', '[data-testid="wide"]']);
});

test("a window below the minimum is reported", async () => {
  await page.setContent("<p>ок</p>");
  const v = await page.evaluate(lintLayout, { minWidth: 5000, minHeight: 480, checkFocus: false });
  expect(rules(v)).toEqual(["window-min"]);
});

test("baseline: matching, any screen, expiry, validation", () => {
  const baseline = parseBaseline({
    exceptions: [
      { rule: "target-size", selector: "#a", reason: "r", until: "2026-12-01" },
      {
        rule: "small-text",
        selector: "#b",
        screen: "code-empty",
        reason: "r",
        until: "2026-12-01",
      },
      { rule: "overlap", selector: "#c", reason: "r", until: "2026-01-01" },
    ],
  });
  const today = "2026-10-25";
  expect(
    excuse({ rule: "target-size", selector: "#a", screen: "x" }, baseline, today),
  ).toBeTruthy();
  expect(
    excuse({ rule: "small-text", selector: "#b", screen: "code-empty" }, baseline, today),
  ).toBeTruthy();
  expect(
    excuse({ rule: "small-text", selector: "#b", screen: "other" }, baseline, today),
  ).toBeUndefined();
  expect(excuse({ rule: "overlap", selector: "#c", screen: "x" }, baseline, today)).toBeUndefined();
  expect(() => parseBaseline({ exceptions: [{ rule: "overlap", selector: "#c" }] })).toThrow(
    /until/,
  );
});
