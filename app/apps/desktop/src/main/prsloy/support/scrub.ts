/**
 * Everything that goes into the support report passes through scrubReportText:
 * - the real gateway key (and any other known secret) verbatim, wherever it appears;
 * - key-shaped strings: `sk-…`, `Bearer …`, `Authorization: …`, secret-named JSON/env
 *   fields, plus the harness's patterns (GitHub, AWS, Slack, Google, private keys);
 * - the user's name: `C:\Users\Иван Петров` → `C:\Users\<user>` (also `/home/…`,
 *   `/Users/…`, JSON-escaped paths, and the bare name);
 * - email addresses.
 */
import { scrubSecrets } from "@prsloy/harness";

export type ScrubContext = {
  /** Exact strings that must never appear (the gateway key, …). */
  secrets: string[];
  /** The OS account name (from os.userInfo / the home dir). */
  userName?: string | undefined;
  /** The home directory, e.g. `C:\Users\Иван Петров`. */
  home?: string | undefined;
};

const USER = "<user>";
const HIDDEN = "<скрыто>";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** The ways a path shows up in logs and JSON: raw, `\\`-escaped, forward slashes. */
function variants(text: string): string[] {
  return [...new Set([text, text.replaceAll("\\", "\\\\"), text.replaceAll("\\", "/")])];
}

export function scrubReportText(input: string, ctx: ScrubContext): string {
  let text = input;
  for (const secret of ctx.secrets) {
    if (secret.length < 6) continue;
    for (const v of variants(secret)) text = text.split(v).join(HIDDEN);
  }
  text = text
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/gu, `sk-${HIDDEN}`)
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{6,}/giu, `$1 ${HIDDEN}`)
    .replace(
      /\b(Authorization|Proxy-Authorization)(["']?\s*[:=]\s*["']?)[^"'\r\n,}]+/giu,
      `$1$2${HIDDEN}`,
    )
    .replace(
      /(["']?[A-Za-z0-9_]*(?:api[_-]?key|apikey|secret|token|password|passwd|credential)[A-Za-z0-9_]*["']?\s*[:=]\s*["']?)([^"'\s,}]{4,})/giu,
      `$1${HIDDEN}`,
    )
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu, "<email>");
  text = scrubSecrets(text).text;
  if (ctx.home) {
    const home = ctx.home.replace(/[\\/]+$/u, "");
    const parent = home.replace(/[\\/][^\\/]+$/u, "");
    const sep = home.includes("\\") ? "\\" : "/";
    const masked = `${parent}${sep}${USER}`;
    for (const [from, to] of [
      [home, masked],
      [home.replaceAll("\\", "\\\\"), masked.replaceAll("\\", "\\\\")],
      [home.replaceAll("\\", "/"), masked.replaceAll("\\", "/")],
    ] as const) {
      if (from) text = text.split(from).join(to);
    }
  }
  if (ctx.userName && ctx.userName.length >= 3) {
    // Paths in other spellings (8.3 names, other drives) and the bare name.
    text = text.replace(
      new RegExp(
        `(Users|home)([\\\\/]{1,2})${escapeRegExp(ctx.userName)}(?=$|[\\\\/"'\\s])`,
        "giu",
      ),
      `$1$2${USER}`,
    );
    text = text.split(ctx.userName).join(USER);
  }
  return text;
}
