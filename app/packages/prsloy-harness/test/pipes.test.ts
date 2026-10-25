// «Трубы» research/24 §2: флаги, виды событий, точки подключения и бенч готовы до реализаций — core, harness и ci
// дальше правят только свои файлы.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vite-plus/test";
import { deriveOutcome, fakeExtractor, listTasks, OUTCOMES } from "../bench/run.ts";
import { createPrsloyHarness } from "../src/index.ts";
import { readFlags } from "../src/flags.ts";
import type { LearningKind } from "../src/learning-log.ts";
import { MockPi } from "./mock-pi.ts";

const root = mkdtempSync(join(tmpdir(), "prsloy-pipes-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => {
  for (const k of [
    "PRSLOY_AUTO_MEMORY",
    "PRSLOY_HONEST_EXIT",
    "PRSLOY_TEST_GUARD",
    "PRSLOY_CLAIM_CHECK",
  ])
    delete process.env[k];
});

const flagsFile = (v: unknown) => {
  const p = join(root, `f-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify(v));
  return p;
};

describe("pipes: flags", () => {
  it("off by default; autoMemory off | shadow | true, the rest booleans", () => {
    expect(readFlags(undefined)).toMatchObject({
      autoMemory: "off",
      honestExit: false,
      testGuard: false,
      claimCheck: false,
    });
    expect(readFlags(flagsFile({ autoMemory: "shadow", honestExit: true }))).toMatchObject({
      autoMemory: "shadow",
      honestExit: true,
      testGuard: false,
    });
    expect(
      readFlags(flagsFile({ autoMemory: true, testGuard: true, claimCheck: true })),
    ).toMatchObject({
      autoMemory: true,
      testGuard: true,
      claimCheck: true,
    });
    // чужие значения — по умолчанию
    expect(readFlags(flagsFile({ autoMemory: "yes", honestExit: "1" }))).toMatchObject({
      autoMemory: "off",
      honestExit: false,
    });
  });

  it("environment overrides the file", () => {
    process.env.PRSLOY_AUTO_MEMORY = "shadow";
    process.env.PRSLOY_HONEST_EXIT = "1";
    process.env.PRSLOY_TEST_GUARD = "0";
    expect(readFlags(flagsFile({ autoMemory: true, testGuard: true }))).toMatchObject({
      autoMemory: "shadow",
      honestExit: true,
      testGuard: false,
    });
    process.env.PRSLOY_AUTO_MEMORY = "on";
    expect(readFlags(undefined).autoMemory).toBe(true);
  });
});

describe("pipes: events and hooks", () => {
  it("event kinds for memory.auto, test_guard, claim, blocker, audit exist", () => {
    const kinds: LearningKind[] = [
      "memory.auto.candidate",
      "memory.auto.saved",
      "memory.auto.refused",
      "memory.auto.reverted",
      "test_guard.touched",
      "test_guard.command_changed",
      "test_guard.signature",
      "claim.unverified",
      "claim.stub",
      "blocker.reported",
      "blocker.accepted",
      "audit.finding",
    ];
    expect(kinds.length).toBe(12);
  });

  it("the hooks are installed but do nothing yet: the harness registers the same tools and handlers", () => {
    const count = (disable: Record<string, boolean>) => {
      const pi = new MockPi(root);
      createPrsloyHarness({ outputDir: join(root, "out"), disable })(pi.api);
      return [pi.tools.size, [...pi.handlers.values()].reduce((n, l) => n + l.length, 0)];
    };
    expect(count({})).toEqual(
      count({ autoMemory: true, honestExit: true, testGuard: true, claimCheck: true }),
    );
  });
});

describe("pipes: bench", () => {
  it("expected outcome defaults to solved; outcome is derived when the check does not name it", () => {
    expect(listTasks().every((t) => t.expectedOutcome === "solved")).toBe(true);
    expect(OUTCOMES).toEqual([
      "solved",
      "honest_fail",
      "disclosed_test_edit",
      "cheat",
      "false_done",
    ]);
    expect(deriveOutcome(true, false)).toBe("solved");
    expect(deriveOutcome(false, true)).toBe("false_done");
    expect(deriveOutcome(false, false)).toBe("honest_fail");
    expect(deriveOutcome(null, false)).toBeNull();
    expect(deriveOutcome(false, false, "cheat")).toBe("cheat");
    expect(deriveOutcome(true, false, "nonsense")).toBe("solved");
  });

  it("fake extractor: replies from fake.json in order, then an empty list", async () => {
    const dir = mkdtempSync(join(root, "task-"));
    writeFileSync(
      join(dir, "fake.json"),
      JSON.stringify({ sessions: [[]], extractor: ['[{"op":"add"}]'] }),
    );
    const extract = fakeExtractor({ dir })!;
    expect(await extract("p")).toBe('[{"op":"add"}]');
    expect(await extract("p")).toBe("[]");
    writeFileSync(join(dir, "fake.json"), JSON.stringify([{ text: "Готово." }]));
    expect(fakeExtractor({ dir })).toBeUndefined();
  });
});
