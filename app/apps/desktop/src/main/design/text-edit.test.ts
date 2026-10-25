import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { tagSource } from "../preview-bridge/source-tags.ts";
import { applyTextEdit, textEditArg } from "./text-edit.ts";

const PAGE = [
  "<!doctype html><html><head><title>Зерно</title></head><body>",
  "<h1 class=t>\n  Зерно &amp; мёд\n</h1>",
  "<p>Обжариваем <b>сами</b></p>",
  "<p data-move=odometer><span>1 240</span></p>",
  "<p>180 ₽</p>",
  "</body></html>",
].join("\n");

function site(html = PAGE) {
  const dir = mkdtempSync(join(tmpdir(), "text-edit-"));
  mkdirSync(join(dir, "landing"));
  writeFileSync(join(dir, "landing", "index.html"), html);
  return dir;
}

/** Where the preview marked the element holding `text`: the last `data-pl` before it. */
function mark(html: string, text: string): { line: number; col: number } {
  const tagged = tagSource(html, "landing/index.html");
  const before = tagged.slice(0, tagged.indexOf(text));
  const m = /data-pl="landing\/index\.html:(\d+):(\d+)"/u.exec(
    before.slice(before.lastIndexOf("data-pl=")),
  )!;
  return { line: Number(m[1]), col: Number(m[2]) };
}

const read = (dir: string) => readFileSync(join(dir, "landing", "index.html"), "utf8");

describe("applyTextEdit", () => {
  it("writes plain text in place, keeping the whitespace around it and escaping it", () => {
    const dir = site();
    const at = mark(PAGE, "Зерно &amp;");
    expect(
      applyTextEdit(dir, {
        file: "landing/index.html",
        ...at,
        before: "Зерно & мёд",
        after: "Зёрна <и> мёд",
      }),
    ).toEqual({ ok: true });
    expect(read(dir)).toContain("<h1 class=t>\n  Зёрна &lt;и&gt; мёд\n</h1>");
    // nothing else moved
    expect(read(dir).replace("Зёрна &lt;и&gt; мёд", "Зерно &amp; мёд")).toBe(PAGE);
  });

  it("refuses text with tags inside, motion's numbers, a changed page, a foreign file", () => {
    const dir = site();
    const nested = mark(PAGE, "Обжариваем");
    const odometer = mark(PAGE, "1 240");
    const price = mark(PAGE, "180 ₽");
    const edit = (over: object) =>
      applyTextEdit(dir, {
        file: "landing/index.html",
        line: 1,
        col: 1,
        before: "",
        after: "x",
        ...over,
      });
    expect(edit({ ...nested, before: "Обжариваем сами" })).toMatchObject({
      error: "Здесь не просто текст — скажите словами через «Править»",
    });
    expect(edit({ ...odometer, before: "1 240" })).toMatchObject({
      error: "Этот текст двигает анимация — скажите словами",
    });
    expect(edit({ ...price, before: "200 ₽" })).toMatchObject({
      error: "Страница поменялась — откройте «Править» заново",
    });
    expect(edit({ line: 99, col: 1, before: "x" })).toMatchObject({ ok: false });
    expect(edit({ ...price, before: "180 ₽", after: "  " })).toMatchObject({ ok: false });
    expect(edit({ ...price, file: "../outside.html", before: "180 ₽" })).toMatchObject({
      error: "Этот текст не из файлов страницы",
    });
    expect(read(dir)).toBe(PAGE);
    expect(edit({ ...price, before: "180 ₽", after: "200 ₽" })).toEqual({ ok: true });
    expect(read(dir)).toContain("<p>200 ₽</p>");
  });

  it("refuses a page that is not UTF-8", () => {
    const dir = site();
    writeFileSync(join(dir, "landing", "index.html"), Buffer.from("<p>caf\xe9</p>", "latin1"));
    expect(
      applyTextEdit(dir, {
        file: "landing/index.html",
        line: 1,
        col: 1,
        before: "café",
        after: "bar",
      }),
    ).toMatchObject({ ok: false });
  });
});

describe("textEditArg", () => {
  it("takes only a whole place", () => {
    expect(textEditArg({ file: "a.html", line: 2, col: 3, before: "x", after: "y" })).toEqual({
      file: "a.html",
      line: 2,
      col: 3,
      before: "x",
      after: "y",
    });
    expect(textEditArg({ file: "a.html", line: 0, col: 3 })).toBeUndefined();
    expect(textEditArg("x")).toBeUndefined();
  });
});
