import { describe, expect, it } from "vite-plus/test";
import { decodePage, tagSource } from "./source-tags.ts";

describe("tagSource", () => {
  it("marks each written element with its file, line and column", () => {
    const html = [
      "<!doctype html>",
      '<html lang="ru"><head><title>Т</title></head>',
      "<body>",
      '  <h1 class="big">Привет, мир</h1>',
      '  <img src="a.png" alt="x"/><br>',
      "</body></html>",
    ].join("\n");
    const out = tagSource(html, "site/index.html");
    expect(out).toContain('<h1 class="big" data-pl="site/index.html:4:3">Привет, мир</h1>');
    expect(out).toContain('<img src="a.png" alt="x" data-pl="site/index.html:5:3"/>');
    expect(out).toContain('<br data-pl="site/index.html:5:29">');
    expect(out).toContain('<html lang="ru" data-pl="site/index.html:2:1">');
    // Nothing else changes.
    expect(out.replace(/ data-pl="[^"]*"/gu, "")).toBe(html);
  });

  it("leaves elements the parser made up unmarked and escapes the file name", () => {
    const out = tagSource("<p>один", 'a"b.html');
    expect(out).toBe('<p data-pl="a&quot;b.html:1:1">один');
  });

  it("leaves <script> and <style> alone", () => {
    expect(tagSource("<script>x()</script><style>p{}</style>", "s.html")).toBe(
      "<script>x()</script><style>p{}</style>",
    );
  });

  it("marks inside <template>", () => {
    expect(tagSource("<template><b>x</b></template>", "t.html")).toContain(
      '<b data-pl="t.html:1:11">',
    );
  });
});

describe("decodePage", () => {
  it("reads UTF-8 as UTF-8 and anything else byte for byte", () => {
    expect(decodePage(Buffer.from("Привет", "utf8"))).toEqual({ text: "Привет", encoding: "utf8" });
    const cp1251 = Buffer.from([0xcf, 0xf0, 0xe8]);
    const page = decodePage(cp1251);
    expect(page.encoding).toBe("latin1");
    expect(Buffer.from(page.text, "latin1")).toEqual(cp1251);
  });
});
