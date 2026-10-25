import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import {
  isAllowedFrameUrl,
  isPreviewPort,
  previewPath,
  previewWorkspace,
  resolvePreviewFile,
} from "./code-preview-guard.ts";

describe("isAllowedFrameUrl (preview frame origin guard)", () => {
  const ports = new Set([5173, 41234]);

  it("allows only http://127.0.0.1 on an opened or served port", () => {
    expect(isAllowedFrameUrl("http://127.0.0.1:5173/", ports)).toBe(true);
    expect(isAllowedFrameUrl("http://127.0.0.1:41234/site/index.html?x=1#top", ports)).toBe(true);
    expect(isAllowedFrameUrl("about:blank", ports)).toBe(true);
    expect(isAllowedFrameUrl("about:srcdoc", ports)).toBe(true);
  });

  it("refuses every other origin", () => {
    for (const url of [
      "http://127.0.0.1:8080/", // port nobody opened
      "http://127.0.0.1/", // default port
      "http://localhost:5173/",
      "http://[::1]:5173/",
      "http://0.0.0.0:5173/",
      "http://127.0.0.2:5173/",
      "http://127.0.0.1.evil.com:5173/",
      "http://user:pw@127.0.0.1:5173/",
      "https://127.0.0.1:5173/",
      "https://example.com/",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,<h1>x</h1>",
      "prsloy-design://ws/x/index.html",
      "zeno-theme://x",
      "not a url",
      "",
    ]) {
      expect(isAllowedFrameUrl(url, ports), url).toBe(false);
    }
  });

  it("checks ports strictly", () => {
    expect(isPreviewPort(5173)).toBe(true);
    for (const value of [0, -1, 65536, 1.5, "5173", Number.NaN, undefined]) {
      expect(isPreviewPort(value)).toBe(false);
    }
  });
});

describe("preview files stay inside the workspace", () => {
  const made: string[] = [];
  afterAll(() => {
    for (const dir of made) rmSync(dir, { recursive: true, force: true });
  });
  function project() {
    const root = mkdtempSync(join(homedir(), ".prsloy-preview-test-"));
    mkdirSync(join(root, "site"), { recursive: true });
    writeFileSync(join(root, "site", "index.html"), "<h1>Визитка</h1>");
    writeFileSync(join(root, "notes.txt"), "x");
    mkdirSync(join(root, ".cache"), { recursive: true });
    writeFileSync(join(root, ".cache", "page.html"), "x");
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    made.push(root, outside);
    writeFileSync(join(outside, "evil.html"), "x");
    let linked = true;
    try {
      symlinkSync(join(outside, "evil.html"), join(root, "site", "link.html"));
    } catch {
      linked = false; // Windows without symlink rights
    }
    return { root, outside, linked };
  }

  it("serves an html file by relative or absolute path", () => {
    const { root } = project();
    expect(resolvePreviewFile(root, "site/index.html")).toMatchObject({
      ok: true,
      rel: "site/index.html",
    });
    expect(resolvePreviewFile(root, join(root, "site", "index.html"))).toMatchObject({
      ok: true,
      rel: "site/index.html",
    });
  });

  it("refuses non-html, missing, escaping, symlinked-out and dotfolder files", () => {
    const { root, outside, linked } = project();
    expect(resolvePreviewFile(root, "notes.txt")).toEqual({ ok: false, reason: "not_html" });
    expect(resolvePreviewFile(root, "site/none.html")).toEqual({ ok: false, reason: "missing" });
    expect(resolvePreviewFile(root, "../evil.html").ok).toBe(false);
    expect(resolvePreviewFile(root, join(outside, "evil.html")).ok).toBe(false);
    if (linked) expect(resolvePreviewFile(root, "site/link.html").ok).toBe(false);
    expect(resolvePreviewFile(root, ".cache/page.html").ok).toBe(false);
  });

  it("never serves the home folder or a drive root as a workspace", () => {
    const { root } = project();
    expect(previewWorkspace(root)).toBe(root);
    expect(previewWorkspace(homedir())).toBeUndefined();
    expect(previewWorkspace("/")).toBeUndefined();
    expect(previewWorkspace("relative/path")).toBeUndefined();
    expect(previewWorkspace(undefined)).toBeUndefined();
  });

  it("encodes each path segment for the URL", () => {
    expect(previewPath("сайт/my page.html")).toBe("%D1%81%D0%B0%D0%B9%D1%82/my%20page.html");
  });
});
