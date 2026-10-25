/**
 * «Править» on the built page (research/20 §1): the places the owner pinned, checked before they
 * reach `run.py say <ws> --edit <file>`. The renderer is trusted only as far as the shape: every
 * string is clamped, numbers are whole, a file path stays inside `site/`.
 */
import type { DesignEditPin } from "@zeno/contracts";

export const MAX_PINS = 10;

function str(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function whole(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

/** A page-relative file the inspector named (`landing/index.html`), or undefined. */
function siteFile(value: unknown): string | undefined {
  const file = str(value, 300).replaceAll("\\", "/");
  if (!file || file.startsWith("/") || /^[a-z]:/i.test(file)) return undefined;
  if (file.split("/").some((part) => part === ".." || part === "")) return undefined;
  return file;
}

/** The pins as main accepts them; pins without a place or without the owner's words are dropped. */
export function editPins(raw: unknown): DesignEditPin[] {
  if (!Array.isArray(raw)) return [];
  const out: DesignEditPin[] = [];
  for (const item of raw.slice(0, MAX_PINS)) {
    if (!item || typeof item !== "object") continue;
    const p = item as Record<string, unknown>;
    const selector = str(p.selector, 400);
    const request = str(p.request, 1000).trim();
    if (!selector || !request) continue;
    const of = whole(p.of, 1, 10_000, 1);
    const pin: DesignEditPin = {
      selector,
      nth: whole(p.nth, 1, of, 1),
      of,
      tag: str(p.tag, 40),
      text: str(p.text, 120),
      outerHTMLShort: str(p.outerHTMLShort, 260),
      request,
      width: whole(p.width, 320, 2560, 1440),
    };
    const file = siteFile(p.file);
    if (file) {
      pin.file = file;
      const line = whole(p.line, 1, 1_000_000, 0);
      if (line) pin.line = line;
    }
    out.push(pin);
  }
  return out;
}

/** What `--edit` reads: the workspace-relative file (`site/<file>`), the rest as given. */
export function editPayload(pins: readonly DesignEditPin[]): { pins: object[] } {
  return {
    pins: pins.map(({ file, line, tag: _tag, ...rest }) => ({
      ...rest,
      ...(file ? { file: `site/${file}`, ...(line ? { line } : {}) } : {}),
    })),
  };
}

/** The owner's message in the stream: one line per place, its words after it. */
export function editSummary(pins: readonly DesignEditPin[]): string {
  return pins
    .map((p, i) => {
      const text = p.text.length > 40 ? `${p.text.slice(0, 40)}…` : p.text;
      const place = text ? `«${text}»` : `<${p.tag || "…"}>`;
      return `${pins.length > 1 ? `${i + 1}. ` : ""}${place} — ${p.request}`;
    })
    .join("\n");
}
