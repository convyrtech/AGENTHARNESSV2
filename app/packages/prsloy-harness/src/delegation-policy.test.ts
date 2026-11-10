import { describe, expect, it } from "vite-plus/test";
import {
  type DelegatedReview,
  decideDelegateStatus,
  differentModelFamilies,
  modelFamily,
  parseDelegatedReview,
  validateDelegateRequest,
} from "./delegation-policy.ts";

const diff =
  "diff --git a/src/a.ts b/src/a.ts\nindex 1..2 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,2 @@\n old\n+const value = 1;\n";
const finding = { file: "src/a.ts", line: 2, problem: "Check this", evidence: "const value = 1;" };
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

  it("requires review evidence from the same changed file and line", () => {
    expect(
      parseDelegatedReview(JSON.stringify({ verdict: "FAIL", items: [finding] }), diff)?.verdict,
    ).toBe("FAIL");
    expect(
      parseDelegatedReview(
        JSON.stringify({ verdict: "FAIL", items: [{ ...finding, evidence: "+const value = 1;" }] }),
        diff,
      ),
    ).toBeUndefined();
    expect(
      parseDelegatedReview(
        JSON.stringify({ verdict: "FAIL", items: [{ ...finding, file: "other.ts" }] }),
        diff,
      ),
    ).toBeUndefined();
    expect(
      parseDelegatedReview(
        JSON.stringify({ verdict: "FAIL", items: [{ ...finding, line: 1 }] }),
        diff,
      ),
    ).toBeUndefined();
    expect(
      parseDelegatedReview(
        JSON.stringify({
          verdict: "FAIL",
          items: [{ ...finding, line: 1, evidence: "const value = 1;" }],
        }),
        diff,
      ),
    ).toBeUndefined();
    expect(
      parseDelegatedReview(JSON.stringify({ verdict: "PASS", items: [finding] }), diff),
    ).toBeUndefined();
  });

  it("accepts a JSON fenced review and keeps invalid FAIL invalid", () => {
    expect(parseDelegatedReview('```json\n{"verdict":"PASS","items":[]}\n```', diff)).toEqual(
      goodReview,
    );
    expect(parseDelegatedReview("{broken", diff)).toBeUndefined();
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
