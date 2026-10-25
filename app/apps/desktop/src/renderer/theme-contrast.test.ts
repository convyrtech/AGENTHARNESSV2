/**
 * Body text keeps WCAG AA contrast (4.5:1) on every surface it sits on, in both themes.
 * Reads the tokens straight from styles.css so a palette tweak cannot quietly regress it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

const css = readFileSync(join(import.meta.dirname, "styles.css"), "utf8");

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  const body = css.slice(start, css.indexOf("\n}\n", start));
  const tokens: Record<string, string> = {};
  for (const m of body.matchAll(/^\s+(--[\w-]+):\s*(#[0-9a-f]{6});/gim)) tokens[m[1]!] = m[2]!;
  return tokens;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const TEXT = ["--foreground", "--muted-foreground", "--group-label-color"];
const SURFACES = [
  "--background",
  "--surface-panel",
  "--surface-muted",
  "--surface-soft",
  "--sidebar",
];

describe.each([
  ["light", '[data-theme="light"]'],
  ["dark", ':root,\n[data-theme="dark"]'],
])("%s theme", (_name, selector) => {
  const tokens = block(selector);

  it.each(TEXT.flatMap((text) => SURFACES.map((surface) => [text, surface])))(
    "%s on %s is at least 4.5:1",
    (text, surface) => {
      expect(tokens[text], text).toBeTruthy();
      expect(tokens[surface], surface).toBeTruthy();
      expect(contrast(tokens[text]!, tokens[surface]!)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it("button text on the accent is at least 4.5:1", () => {
    expect(contrast(tokens["--primary-foreground"]!, tokens["--primary"]!)).toBeGreaterThanOrEqual(
      4.5,
    );
  });
});
