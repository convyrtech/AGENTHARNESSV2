/**
 * The honest exit's card (research/24 §4.2, §4.5): `prsloy-harness.blocker` with
 * `details: BlockerCardDetails`. What the page code reads: the three lines and up to three
 * ready answers; anything odd is dropped, a card without details shows its plain text.
 */
import type { BlockerCardDetails } from "@zeno/contracts";

export const BLOCKER_TYPE = "prsloy-harness.blocker";

function line(value: unknown, max = 600): string {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim().slice(0, max) : "";
}

export function parseBlockerDetails(details: unknown): BlockerCardDetails | undefined {
  const d = details as Record<string, unknown> | null | undefined;
  const what = line(d?.what);
  const why = line(d?.why);
  const need = line(d?.need);
  if (!what || !why || !need) return undefined;
  const options = Array.isArray(d?.options)
    ? [...new Set(d.options.map((o) => line(o, 200)).filter(Boolean))].slice(0, 3)
    : [];
  const reason = line(d?.reason, 60);
  return { what, why, need, ...(reason ? { reason } : {}), ...(options.length ? { options } : {}) };
}
