/**
 * A file or folder name every system accepts, Windows first: no reserved device names
 * (CON, PRN, AUX, NUL, COM1–9, LPT1–9, with any extension — `nul.txt` is NUL too), no
 * characters Windows refuses or control characters, no dots or spaces at the ends (Windows
 * drops trailing ones, so «Сайт.» would silently be another folder «Сайт»), never «.»/«..»,
 * and at most 80 characters.
 */
export const MAX_NAME = 80;

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Letters as a person sees them: an emoji or «й» is one, whatever its code points. */
export function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (part) => part.segment);
}

const RESERVED = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/iu;

export function safeName(
  raw: string,
  options: { fallback: string; replacement?: string; max?: number },
): string {
  const max = options.max ?? MAX_NAME;
  const replacement = options.replacement ?? " ";
  const trimEnds = (text: string) => text.replace(/^[.\s]+|[.\s]+$/gu, "");
  let name = trimEnds(raw.replace(/[\p{Cc}\\/:*?"<>|]+/gu, replacement).replace(/\s+/gu, " "));
  // Cut by letters, not UTF-16 units; the cut may end in a dot or a space again.
  name = trimEnds(graphemes(name).slice(0, max).join(""));
  if (!name) return options.fallback;
  if (RESERVED.test(name.split(".")[0]?.trim() ?? "")) name = `_${name}`.slice(0, max);
  return name;
}

/** `name` with ` N` appended, the whole still within `max`. */
export function withSuffix(name: string, n: number, max = MAX_NAME): string {
  const suffix = ` ${n}`;
  const base = graphemes(name)
    .slice(0, max - suffix.length)
    .join("")
    .replace(/[.\s]+$/gu, "");
  return `${base}${suffix}`;
}
