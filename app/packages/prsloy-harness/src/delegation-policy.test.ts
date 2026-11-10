import { describe, expect, it } from "vite-plus/test";
import {
  type DelegatedReview,
  buildDelegatedReviewPatch,
  decideDelegateStatus,
  differentModelFamilies,
  modelFamily,
  parseDelegatedReview,
  validateDelegateRequest,
} from "./delegation-policy.ts";

const diff =
  "diff --git a/src/a.ts b/src/a.ts\nindex 1..2 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,2 @@\n old\n+const value = 1;\n";
const finding = { file: "src/a.ts", line: 2, problem: "Check this", evidence: "const value = 1;" };
const anchored = buildDelegatedReviewPatch(diff);
const goodReview: DelegatedReview = { verdict: "PASS", items: [] };
const ready = {
  cancelled: false,
  budgetExceeded: false,
  workerFailed: false,
  check: { command: "npm test", exitCode: 0, cancelled: false },
  review: goodReview,
  reviewedDigest: "abc",
  currentDigest: "abc",
  differentFamily: true,
};

describe("delegation policy", () => {
  it("validates requests and normalizes Windows separators", () => {
    expect(
      validateDelegateRequest({ task: " do it ", paths: ["src\\a.ts"], check: " test " }),
    ).toEqual({
      task: "do it",
      paths: ["src/a.ts"],
      check: "test",
    });
    expect(() =>
      validateDelegateRequest({ task: "x", paths: ["../secret"], check: "x" }),
    ).toThrow();
    expect(() =>
      validateDelegateRequest({ task: "x", paths: [".env.local"], check: "x" }),
    ).toThrow();
    for (const path of ["src\\CON.txt", "src\\file. ", "src\\bad?.ts", "\\\\?\\C:\\secret"]) {
      expect(() => validateDelegateRequest({ task: "x", paths: [path], check: "x" })).toThrow();
    }
  });

  it("treats model IDs in a family as the same reviewer family", () => {
    expect(modelFamily("gateway/opus-4")).toBe("anthropic");
    expect(differentModelFamilies("claude-4", "fable-2")).toBe(false);
    expect(modelFamily("vendor/unknown-model")).toBeUndefined();
    expect(differentModelFamilies("gpt-6", "unknown-model")).toBe(false);
  });

  it("resolves IDs to trusted file, resulting line, and exact evidence", () => {
    expect(anchored.diff).toContain("+ [L2] const value = 1;");
    expect(
      parseDelegatedReview(
        JSON.stringify({ verdict: "FAIL", items: [{ id: "L2", problem: "Check this" }] }),
        anchored,
      ),
    ).toEqual({ verdict: "FAIL", items: [finding] });
  });

  it("rejects guessed lines, stale/unknown IDs, and extra attributes", () => {
    for (const response of [
      { verdict: "FAIL", items: [{ ...finding }] },
      { verdict: "FAIL", items: [{ id: "L999", problem: "No such anchor" }] },
      { verdict: "FAIL", items: [{ id: "L2", problem: "Check this", line: 1 }] },
      { verdict: "FAIL", items: [{ id: "L2", problem: "Check this", evidence: "fake" }] },
      { verdict: "FAIL", extra: true, items: [{ id: "L2", problem: "Check this" }] },
      { verdict: "PASS", items: [{ id: "L2", problem: "Check this" }] },
    ]) {
      expect(parseDelegatedReview(JSON.stringify(response), anchored)).toBeUndefined();
    }
  });

  it("maps the 143/146 hunk case to the actual resulting line and handles multiple files", () => {
    const multi = buildDelegatedReviewPatch(
      [
        "diff --git a/src one/a.ts b/src one/a.ts",
        "--- a/src b/one/a.ts",
        "+++ b/src b/one/a.ts",
        "@@ -141,3 +144,3 @@",
        " before",
        "-old guard",
        "+new guard",
        " return value;",
        "diff --git a/src two/b.ts b/src two/b.ts",
        "--- a/src two/b.ts",
        "+++ b/src two/b.ts",
        "@@ -1,2 +1,2 @@",
        " duplicate();",
        " duplicate();",
      ].join("\n"),
    );
    expect(multi.anchors.get("L4")).toEqual({
      file: "src b/one/a.ts",
      line: 146,
      evidence: "return value;",
    });
    expect(multi.anchors.get("L5")).toEqual({
      file: "src two/b.ts",
      line: 1,
      evidence: "duplicate();",
    });
    expect(multi.anchors.get("L6")).toEqual({
      file: "src two/b.ts",
      line: 2,
      evidence: "duplicate();",
    });
    expect(
      parseDelegatedReview(
        JSON.stringify({
          verdict: "FAIL",
          items: [{ id: "L4", problem: "Wrong line guess was 143" }],
        }),
        multi,
      )?.items[0]?.line,
    ).toBe(146);
  });

  it("does not treat IDs inside source text as anchors and anchors deletions as old lines", () => {
    const mixed = buildDelegatedReviewPatch(
      [
        "diff --git a/a.ts b/a.ts",
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -1 +1 @@",
        '-const marker = "[L900]";',
        '+const marker = "[L1]";',
        "diff --git a/removed file.ts b/removed file.ts",
        "deleted file mode 100644",
        "--- a/removed file.ts",
        "+++ /dev/null",
        "@@ -7,1 +0,0 @@",
        "-old behavior();",
      ].join("\n"),
    );
    expect([...mixed.anchors.keys()]).toEqual(["L1", "L2", "L3"]);
    expect(mixed.anchors.get("L1")).toEqual({
      file: "a.ts",
      line: 1,
      evidence: 'const marker = "[L900]";',
      side: "old",
    });
    expect(mixed.anchors.get("L3")).toEqual({
      file: "removed file.ts",
      line: 7,
      evidence: "old behavior();",
      side: "old",
    });
    expect(
      parseDelegatedReview(
        JSON.stringify({
          verdict: "FAIL",
          items: [{ id: "L3", problem: "Deletion removed behavior" }],
        }),
        mixed,
      )?.items[0],
    ).toEqual({
      file: "removed file.ts",
      line: 7,
      side: "old",
      problem: "Deletion removed behavior",
      evidence: "old behavior();",
    });
    expect(
      parseDelegatedReview(
        JSON.stringify({ verdict: "FAIL", items: [{ id: "L900", problem: "Fake" }] }),
        mixed,
      ),
    ).toBeUndefined();
    expect(mixed.diff).toContain('- [L1] const marker = "[L900]";');
  });

  it("keeps plus-prefixed hunk content and rejects malformed IDs or oversized findings", () => {
    const plus = buildDelegatedReviewPatch(
      "diff --git a/p.ts b/p.ts\n--- a/p.ts\n+++ b/p.ts\n@@ -0,0 +1,1 @@\n+++literal",
    );
    expect(plus.anchors.get("L1")).toEqual({ file: "p.ts", line: 1, evidence: "++literal" });
    for (const item of [
      { id: "L0", problem: "bad" },
      { id: "L01", problem: "bad" },
      { id: "L1", problem: "x".repeat(1201) },
    ]) {
      expect(
        parseDelegatedReview(JSON.stringify({ verdict: "FAIL", items: [item] }), plus),
      ).toBeUndefined();
    }
  });

  it("accepts a JSON fenced review and keeps invalid FAIL invalid", () => {
    expect(parseDelegatedReview('```json\n{"verdict":"PASS","items":[]}\n```', anchored)).toEqual(
      goodReview,
    );
    expect(parseDelegatedReview("{broken", anchored)).toBeUndefined();
  });

  it("only verifies a passing check, independent review, and unchanged digest", () => {
    expect(decideDelegateStatus(ready)).toBe("verified");
    expect(
      decideDelegateStatus({ ...ready, check: { command: "x", exitCode: null, cancelled: false } }),
    ).toBe("unverified");
    expect(
      decideDelegateStatus({ ...ready, check: { command: "x", exitCode: 1, cancelled: false } }),
    ).toBe("unverified");
    expect(
      decideDelegateStatus({ ...ready, check: { command: "x", exitCode: 0, cancelled: true } }),
    ).toBe("unverified");
    expect(decideDelegateStatus({ ...ready, reviewedDigest: "old" })).toBe("unverified");
    expect(decideDelegateStatus({ ...ready, review: { verdict: "FAIL", items: [finding] } })).toBe(
      "needs_changes",
    );
    expect(decideDelegateStatus({ ...ready, cancelled: true, budgetExceeded: true })).toBe(
      "cancelled",
    );
    expect(decideDelegateStatus({ ...ready, budgetExceeded: true, workerFailed: true })).toBe(
      "budget_exceeded",
    );
    expect(decideDelegateStatus({ ...ready, workerFailed: true })).toBe("failed");
  });
});
