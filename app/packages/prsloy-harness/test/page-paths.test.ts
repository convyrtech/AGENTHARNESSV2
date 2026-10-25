// Пути от корня в страницах: файл, открытый двойным кликом, ищет их в корне диска (стенд a6).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { absoluteRefs, checkPagePaths, pagePathsMessage } from "../src/page-paths.ts";

const root = mkdtempSync(join(tmpdir(), "prsloy-paths-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
function project(files: Record<string, string>): string {
  const dir = join(root, `p${n++}`);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

describe("page paths", () => {
  it("finds src, <link href> and url() from the root; leaves //cdn, http, ./ and <a href=/> alone", () => {
    const html = `<link rel="stylesheet" href="/style.css"><script src="/assets/index-a1.js"></script>
<img src="./logo.png"><script src="//cdn.example/x.js"></script><script src="https://x.example/y.js"></script>
<a href="/">Домой</a><style>@font-face { src: url('/fonts/a.woff2') }</style>`;
    expect(absoluteRefs(html, false)).toEqual([
      "/assets/index-a1.js",
      "/style.css",
      "/fonts/a.woff2",
    ]);
    expect(
      absoluteRefs("body { background: url(/img/bg.png) } a { background: url(./x.png) }", true),
    ).toEqual(["/img/bg.png"]);
  });

  it("plain site: every page and stylesheet; relative paths — clean", () => {
    const bad = project({
      "index.html": '<link href="/css/main.css" rel="stylesheet">',
      "css/main.css": "@font-face { src: url(/fonts/a.woff2) }",
      "node_modules/x/index.html": '<script src="/ignored.js"></script>',
    });
    expect(checkPagePaths(bad).issues).toEqual([
      { file: "css/main.css", ref: "/fonts/a.woff2" },
      { file: "index.html", ref: "/css/main.css" },
    ]);
    const good = project({ "index.html": '<link href="./css/main.css" rel="stylesheet">' });
    expect(checkPagePaths(good)).toEqual({ issues: [] });
  });

  it("Vite and type=module pages are left to the server check: they never open by double click", () => {
    const vite = project({
      "vite.config.ts": "export default {}",
      "index.html": '<script type="module" src="/src/main.ts"></script>',
      "dist/index.html": '<script type="module" crossorigin src="/assets/index-Bx1.js"></script>',
    });
    expect(checkPagePaths(vite)).toEqual({ issues: [] });
    const module = project({
      "index.html": '<script type="module" src="/main.js"></script>',
      "style.css": "body { background: url(/bg.png) }",
    });
    expect(checkPagePaths(module).issues).toEqual([{ file: "style.css", ref: "/bg.png" }]);
  });

  it("message: files and the last attempt", () => {
    const text = pagePathsMessage({ issues: [{ file: "index.html", ref: "/style.css" }] }, 2, 2);
    expect(text).toContain("- index.html: /style.css");
    expect(text).not.toContain("Vite");
    expect(text).toContain("Это последняя попытка");
  });
});
