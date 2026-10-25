// M-0 приёмка (research/24 §3.1, §3.4): 100 размеченных пар text ↔ quote и 30 пар записей.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  hashedSignature,
  matchesForgotten,
  relation,
  signature,
  textMatchesQuote,
} from "../src/memory-match.ts";

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures", "memory-pairs.json"), "utf8"),
) as {
  pairs: { text: string; quote: string; label: "link" | "polarity" | "unrelated" }[];
  entries: { a: string; b: string; label: "same" | "contradicts" | "different" }[];
};

describe("memory-match: text ↔ quote on 100 labeled pairs", () => {
  const links = fixture.pairs.filter((p) => p.label === "link");
  const refused = links.filter((p) => !textMatchesQuote(p.text, p.quote));
  const negated = fixture.pairs.filter((p) => p.label === "polarity");
  const unrelated = fixture.pairs.filter((p) => p.label === "unrelated");

  it("has 100 pairs", () => {
    expect(fixture.pairs).toHaveLength(100);
  });

  it("false refusals of real paraphrases ≤ 10%", () => {
    console.log(
      `[memory-match] links ${links.length}, refused ${refused.length}:\n${refused.map((p) => `  «${p.text}» ← «${p.quote}»`).join("\n")}`,
    );
    expect(refused.length / links.length).toBeLessThanOrEqual(0.1);
  });

  it("a negated quote never confirms the record (0 accepted)", () => {
    const accepted = negated.filter((p) => textMatchesQuote(p.text, p.quote));
    expect(accepted.map((p) => p.text)).toEqual([]);
  });

  it("unrelated text is not linked to the quote", () => {
    const accepted = unrelated.filter((p) => textMatchesQuote(p.text, p.quote));
    console.log(`[memory-match] unrelated accepted: ${accepted.length}/${unrelated.length}`);
    expect(accepted.length / unrelated.length).toBeLessThanOrEqual(0.1);
  });
});

describe("memory-match: records against records", () => {
  it("duplicates found, contradictions never merged, different stays different", () => {
    const wrong = fixture.entries.filter(
      (e) => relation(signature(e.a), signature(e.b)) !== e.label,
    );
    console.log(
      `[memory-match] entries wrong ${wrong.length}/${fixture.entries.length}:\n${wrong.map((e) => `  ${e.label}: «${e.a}» / «${e.b}» → ${relation(signature(e.a), signature(e.b))}`).join("\n")}`,
    );
    // Merging with a negation is the forbidden mistake: 0.
    const merged = fixture.entries.filter(
      (e) => e.label === "contradicts" && relation(signature(e.a), signature(e.b)) === "same",
    );
    expect(merged).toEqual([]);
    expect(wrong.length / fixture.entries.length).toBeLessThanOrEqual(0.1);
  });

  it("forgotten by stem hashes: a paraphrase is caught, a negation is not", () => {
    const forgotten = hashedSignature("Пользователь любит тёмные сайты");
    expect(matchesForgotten("Нравятся тёмные сайты, любит", forgotten)).toBe(true);
    expect(matchesForgotten("Любит тёмный сайт", forgotten)).toBe(true);
    expect(matchesForgotten("Пользователь не любит тёмные сайты", forgotten)).toBe(false);
    expect(matchesForgotten("Любит котов", forgotten)).toBe(false);
    // Only hashes are kept, not the words.
    expect(JSON.stringify(forgotten)).not.toMatch(/тёмн|темн|сайт/u);
  });
});
