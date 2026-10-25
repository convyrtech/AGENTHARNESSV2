/**
 * «Настроить» on the built page: the brand's CSS variables on `:root` as a few handles, no model.
 * Idea from Open CoDesign's tweaks (MIT): the page keeps its decisions in variables, the app moves them.
 *
 * Only names a casual owner understands are offered (background, text, accent, corner radius, text
 * size, spacing). Colours are picked from the brand's own swatches, never a free picker; lengths stay
 * within 0.5–2× of what the page had. Text and accent must keep their contrast with the background.
 * Nothing touches the disk until «Сохранить»: the preview server injects the overrides meanwhile.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { DesignToken, DesignTokenKind, DesignTokenLabel } from "@zeno/contracts";

type Known = { kind: DesignTokenKind; label: DesignTokenLabel; role?: "paper" | "ink" | "accent" };
/** For the one-line refusals main sends (Russian, like its other errors); the handles are translated by the renderer. */
const RU: Record<DesignTokenLabel, string> = {
  background: "Фон",
  text: "Текст",
  accent: "Акцент",
  radius: "Скругление",
  size: "Размер текста",
  spacing: "Отступы",
};
/** First match wins; the order is the order of the handles. */
const KNOWN: [RegExp, Known][] = [
  [/^--(paper|bg|background|surface)$/, { kind: "color", label: "background", role: "paper" }],
  [/^--(ink|text|fg|foreground)$/, { kind: "color", label: "text", role: "ink" }],
  [/^--(accent|brand|primary)$/, { kind: "color", label: "accent", role: "accent" }],
  [/^--(radius|r|corner)$/, { kind: "length", label: "radius" }],
  [/^--(step|fs|font-size|text-size|size-base)$/, { kind: "length", label: "size" }],
  [/^--(space|gap|spacing|pad)$/, { kind: "length", label: "spacing" }],
];
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const LENGTH = /^(\d+(?:\.\d+)?)(px|rem|em)$/;
const ROOT = /:root\s*\{([^}]*)\}/g;
const DECL = /(--[\w-]+)\s*:\s*([^;}]+?)\s*(?=;|$)/g;
const MAX_FILE = 1 << 20;

type Found = DesignToken & { file: string; start: number; end: number };

function files(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      const st = statSync(full, { throwIfNoEntry: false });
      if (!st) continue;
      if (st.isDirectory()) walk(full);
      else if (/\.(css|html?)$/i.test(name) && st.size <= MAX_FILE) out.push(full);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

function known(name: string): Known | undefined {
  return KNOWN.find(([re]) => re.test(name))?.[1];
}

function scan(pageDir: string): Found[] {
  const seen = new Map<string, Found>();
  for (const file of files(pageDir)) {
    const text = readFileSync(file, "utf8");
    for (const root of text.matchAll(ROOT)) {
      const bodyAt = root.index + root[0].indexOf("{") + 1;
      for (const d of root[1]!.matchAll(DECL)) {
        const name = d[1]!;
        const value = d[2]!.trim();
        const k = known(name);
        // one handle per meaning: --space and --gap would both be «spacing»
        if (!k || seen.has(name) || [...seen.values()].some((t) => t.label === k.label)) continue;
        if (k.kind === "color" ? !HEX.test(value) : !LENGTH.test(value)) continue;
        const start = bodyAt + d.index + d[0].lastIndexOf(d[2]!);
        seen.set(name, {
          name,
          value,
          kind: k.kind,
          label: k.label,
          file: relative(pageDir, file).split(sep).join("/"),
          start,
          end: start + d[2]!.length,
        });
      }
    }
  }
  const order = (t: Found) => KNOWN.findIndex(([re]) => re.test(t.name));
  return [...seen.values()].sort((a, b) => order(a) - order(b));
}

/** Handles for the page in `<site>/<page>/`: values as they are on disk, colour swatches of the brand. */
export function readTokens(
  siteDir: string,
  page: string,
): { tokens: DesignToken[]; swatches: string[] } {
  const found = scan(join(siteDir, page));
  const swatches = [
    ...new Set(found.filter((t) => t.kind === "color").map((t) => t.value.toLowerCase())),
  ];
  return {
    tokens: found.map(({ name, value, kind, label }) => ({ name, value, kind, label })),
    swatches,
  };
}

function rgb(hex: string): [number, number, number] {
  const h = hex.length === 4 ? hex.replace(/[0-9a-f]/gi, (c) => c + c) : hex;
  return [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** WCAG contrast ratio of two hex colours. */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

export type TokenCheck = { ok: true } | { ok: false; error: string };

/** Are these changes allowed? Same kind, within bounds, brand swatches only, contrast kept. */
export function checkTokens(
  siteDir: string,
  page: string,
  changes: Record<string, string>,
): TokenCheck {
  const found = scan(join(siteDir, page));
  const byName = new Map(found.map((t) => [t.name, t]));
  const swatches = new Set(
    found.filter((t) => t.kind === "color").map((t) => t.value.toLowerCase()),
  );
  const after = new Map(found.map((t) => [t.name, t.value]));
  for (const [name, raw] of Object.entries(changes)) {
    const t = byName.get(name);
    const value = String(raw).trim();
    if (!t) return { ok: false, error: `Такой настройки на странице нет: ${name}` };
    if (t.kind === "color") {
      if (!HEX.test(value) || !swatches.has(value.toLowerCase())) {
        return { ok: false, error: "Цвет берётся только из цветов вашего бренда" };
      }
    } else {
      const was = LENGTH.exec(t.value)!;
      const now = LENGTH.exec(value);
      if (!now || now[2] !== was[2])
        return { ok: false, error: `«${RU[t.label]}»: нужен размер в ${was[2]}` };
      const ratio = Number(now[1]) / Number(was[1]);
      if (!(ratio >= 0.5 && ratio <= 2))
        return { ok: false, error: `«${t.label}»: слишком далеко от исходного` };
    }
    after.set(name, value);
  }
  const role = (r: Known["role"]) => found.find((t) => known(t.name)?.role === r)?.name;
  const [paper, ink, accent] = [role("paper"), role("ink"), role("accent")];
  if (paper && ink && contrast(after.get(paper)!, after.get(ink)!) < 4.5) {
    return { ok: false, error: "Текст станет плохо читаться на этом фоне" };
  }
  if (paper && accent && contrast(after.get(paper)!, after.get(accent)!) < 3) {
    return { ok: false, error: "Акцент потеряется на этом фоне" };
  }
  return { ok: true };
}

/** `:root` overrides the preview server puts into the page while the owner moves the handles. */
export function overrideStyle(changes: Record<string, string>): string {
  const decls = Object.entries(changes)
    .filter(([name, value]) => /^--[\w-]+$/.test(name) && /^[#\w.%-]+$/.test(value))
    .map(([name, value]) => `${name}:${value} !important`)
    .join(";");
  return decls ? `<style id="prsloy-tweaks">:root{${decls}}</style>` : "";
}

/** «Сохранить»: the changes into the files they came from (checked first; nothing else in the file moves). */
export function saveTokens(
  siteDir: string,
  page: string,
  changes: Record<string, string>,
): TokenCheck {
  const check = checkTokens(siteDir, page, changes);
  if (!check.ok) return check;
  const pageDir = join(siteDir, page);
  const byFile = new Map<string, Found[]>();
  for (const t of scan(pageDir)) {
    if (!(t.name in changes)) continue;
    byFile.set(t.file, [...(byFile.get(t.file) ?? []), t]);
  }
  for (const [file, list] of byFile) {
    const full = join(pageDir, ...file.split("/"));
    let text = readFileSync(full, "utf8");
    for (const t of list.sort((a, b) => b.start - a.start)) {
      text = text.slice(0, t.start) + changes[t.name]!.trim() + text.slice(t.end);
    }
    writeFileSync(full, text);
  }
  return { ok: true };
}
