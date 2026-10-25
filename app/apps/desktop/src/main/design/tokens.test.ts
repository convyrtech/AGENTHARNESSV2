import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { checkTokens, contrast, overrideStyle, readTokens, saveTokens } from "./tokens.ts";

const CSS = `/* бренд */\n:root {\n  --paper: #f4ede1;\n  --ink: #2b211b;\n  --accent: #b4532a;\n  --radius: 12px;\n  --step: 1.125rem;\n  --m-ease: cubic-bezier(.2,.7,.2,1);\n}\nbody { background: var(--paper); }\n`;
const HTML = `<!doctype html><html><head><style>:root{--space:16px;--gap:8px}</style><link rel="stylesheet" href="brand.css"></head><body>x</body></html>`;

function site() {
  const root = mkdtempSync(join(tmpdir(), "tokens-"));
  const page = join(root, "landing");
  mkdirSync(page, { recursive: true });
  writeFileSync(join(page, "brand.css"), CSS);
  writeFileSync(join(page, "index.html"), HTML);
  return { root, page };
}

describe("readTokens", () => {
  it("offers the handles an owner understands, in a fixed order, with the brand's swatches", () => {
    const { root } = site();
    const { tokens, swatches } = readTokens(root, "landing");
    expect(tokens.map((t) => [t.name, t.label, t.value])).toEqual([
      ["--paper", "background", "#f4ede1"],
      ["--ink", "text", "#2b211b"],
      ["--accent", "accent", "#b4532a"],
      ["--radius", "radius", "12px"],
      ["--step", "size", "1.125rem"],
      ["--space", "spacing", "16px"],
    ]);
    expect(swatches).toEqual(["#f4ede1", "#2b211b", "#b4532a"]);
  });

  it("finds nothing on a page without :root variables", () => {
    const root = mkdtempSync(join(tmpdir(), "tokens-"));
    mkdirSync(join(root, "landing"));
    writeFileSync(join(root, "landing", "index.html"), "<p>x</p>");
    expect(readTokens(root, "landing")).toEqual({ tokens: [], swatches: [] });
  });
});

describe("checkTokens", () => {
  it("keeps colours to the brand, lengths within 0.5–2× in the same unit, and contrast", () => {
    const { root } = site();
    const ok = (c: Record<string, string>) => checkTokens(root, "landing", c);
    expect(ok({ "--radius": "20px", "--step": "1.3rem", "--accent": "#2b211b" })).toEqual({
      ok: true,
    });
    expect(ok({ "--accent": "#ff00ff" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("бренда"),
    });
    expect(ok({ "--radius": "40px" })).toMatchObject({ error: expect.stringContaining("далеко") });
    expect(ok({ "--radius": "1rem" })).toMatchObject({ error: expect.stringContaining("px") });
    expect(ok({ "--m-ease": "linear" })).toMatchObject({ error: expect.stringContaining("нет") });
    // text the colour of the background, accent lost on it
    expect(ok({ "--ink": "#f4ede1" })).toMatchObject({
      error: "Текст станет плохо читаться на этом фоне",
    });
    expect(ok({ "--accent": "#f4ede1" })).toMatchObject({
      error: "Акцент потеряется на этом фоне",
    });
  });

  it("measures contrast the WCAG way", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 0);
    expect(contrast("#fff", "#fff")).toBe(1);
  });
});

describe("saveTokens and overrideStyle", () => {
  it("writes only the changed values, in the file they came from", () => {
    const { root, page } = site();
    expect(saveTokens(root, "landing", { "--radius": "18px", "--space": "24px" })).toEqual({
      ok: true,
    });
    expect(readFileSync(join(page, "brand.css"), "utf8")).toBe(
      CSS.replace("--radius: 12px", "--radius: 18px"),
    );
    expect(readFileSync(join(page, "index.html"), "utf8")).toBe(
      HTML.replace("--space:16px", "--space:24px"),
    );
    expect(saveTokens(root, "landing", { "--ink": "#f4ede1" }).ok).toBe(false);
    expect(readFileSync(join(page, "brand.css"), "utf8")).toContain("--ink: #2b211b");
  });

  it("previews as a :root style and drops anything that is not a plain value", () => {
    expect(overrideStyle({ "--radius": "18px", "--accent": "#2b211b" })).toBe(
      '<style id="prsloy-tweaks">:root{--radius:18px !important;--accent:#2b211b !important}</style>',
    );
    expect(overrideStyle({ "--x": "red;}</style><script>alert(1)</script>" })).toBe("");
    expect(overrideStyle({})).toBe("");
  });
});
