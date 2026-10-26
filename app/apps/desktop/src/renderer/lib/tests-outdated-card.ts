/**
 * #25 (owner, 26.10): old tests that disagree with the request are not changed silently — the harness
 * says they look outdated and offers to update them: `prsloy-harness.tests-outdated` with
 * `details: TestsOutdatedCardDetails`. What the page reads: the files, the conflicting assertion, the
 * request and the buttons; anything odd is dropped.
 */
import type { TestsOutdatedCardDetails } from "@zeno/contracts";

export const TESTS_OUTDATED_TYPE = "prsloy-harness.tests-outdated";

export type TestsOutdatedDetails = TestsOutdatedCardDetails;

/** A quote longer than this (or over 3 lines) starts folded. */
export const QUOTE_FOLD_CHARS = 180;

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function parseTestsOutdated(details: unknown): TestsOutdatedDetails | undefined {
  const d = details as Record<string, unknown> | null | undefined;
  if (!d) return undefined;
  const files = Array.isArray(d.files)
    ? [...new Set(d.files.map((f) => text(f, 200)).filter(Boolean))].slice(0, 5)
    : [];
  const actions = Array.isArray(d.actions)
    ? d.actions.flatMap((raw) => {
        const a = raw as { label?: unknown; prompt?: unknown } | null;
        const label = text(a?.label, 60);
        if (!label) return [];
        const prompt = text(a?.prompt, 2000);
        return [prompt ? { label, prompt } : { label }];
      })
    : [];
  if (actions.length === 0) return undefined;
  return {
    files,
    quote: text(d.quote, 4000),
    request: text(d.request, 2000),
    actions: actions.slice(0, 3),
  };
}

export function quoteIsLong(quote: string): boolean {
  return quote.length > QUOTE_FOLD_CHARS || quote.split("\n").length > 3;
}

const ANSWERED_KEY = "prsloy.testsOutdated.answered";

/** The same card (request, files, quote) answered once stays answered, also after the chat is reopened. */
export function testsOutdatedKey(d: TestsOutdatedDetails): string {
  return [d.request, d.files.join("|"), d.quote].join("\u0000");
}

export function readAnswered(key: string): string | undefined {
  try {
    const all = JSON.parse(localStorage.getItem(ANSWERED_KEY) ?? "{}") as Record<string, string>;
    return typeof all[key] === "string" ? all[key] : undefined;
  } catch {
    return undefined;
  }
}

export function markAnswered(key: string, label: string): void {
  try {
    const all = JSON.parse(localStorage.getItem(ANSWERED_KEY) ?? "{}") as Record<string, string>;
    const entries = Object.entries({ ...all, [key]: label }).slice(-50);
    localStorage.setItem(ANSWERED_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // storage off: the card still locks for this view
  }
}
