import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { listTasks } from "../bench/run.ts";
import { buildContext } from "../src/tuner/context.ts";
import { FAKE_DELTA, FAKE_SKILL, fakeScripts } from "../src/tuner/fake.ts";
import {
  assertNoCheckText,
  assertNoGraderVerdicts,
  assertNoLeakPaths,
  assertTreeHasNoGraderVerdicts,
  checkFingerprints,
} from "../src/tuner/leaks.ts";
import { assertModelSawNoGrader, outsidePaths, runPpc } from "../src/tuner/ppc.ts";
import { editorPrompt } from "../src/tuner/prompts.ts";
import {
  assertTrainOnly,
  loadSplit,
  seededSplit,
  unstableSplit,
  writeSplitOnce,
  type Split,
} from "../src/tuner/split.ts";
import {
  baseTree,
  benchOptionsFor,
  type HarnessTree,
  readTree,
  validateTree,
} from "../src/tuner/tree.ts";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP = join(PKG, "..", "..");
const tmp = (name: string) => mkdtempSync(join(tmpdir(), `tuner-${name}-`));
const MODEL = "prsloy/deepseek-v4.1-flash-1017";

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => join(d.parentPath, d.name));
}

describe("tuner tripwires (harness2 context.assert_no_*)", () => {
  it("refuse answer-key paths, grader verdicts and check.mjs lines in the context", () => {
    const dir = tmp("leak");
    writeFileSync(join(dir, "transcript.md"), "[S1] USER: почини цену");
    expect(() => assertNoLeakPaths(dir)).not.toThrow();
    expect(() => assertNoGraderVerdicts(dir)).not.toThrow();

    mkdirSync(join(dir, "t"));
    writeFileSync(join(dir, "t", "check.mjs"), "export default 1");
    expect(() => assertNoLeakPaths(dir)).toThrow(/answer-key path/);

    const d2 = tmp("verdict");
    writeFileSync(join(d2, "files.md"), 'report: {"ok": false, "note": "цена 900"}');
    expect(() => assertNoGraderVerdicts(d2)).toThrow(/grader verdict/);

    const d3 = tmp("check");
    const check = join(d3, "..", `check-${Date.now()}.mjs`);
    writeFileSync(
      check,
      'if (calc(1000, 10) !== 900) throw new Error("скидка считается неверно");\n',
    );
    const prints = checkFingerprints([check]);
    expect(prints).toHaveLength(1);
    writeFileSync(join(d3, "files.md"), `агент вставил: ${prints[0]}`);
    expect(() => assertNoCheckText(d3, prints)).toThrow(/check\.mjs text/);

    expect(() =>
      assertTreeHasNoGraderVerdicts({ "model-delta.md": "the grader expects X" }),
    ).toThrow();
    expect(() => assertModelSawNoGrader([JSON.stringify('{"ok": true}')], [])).toThrow(
      /ответ проверки/,
    );
  });

  it("a role that reads outside its folder and the evidence is caught by its tool paths", () => {
    const call = (name: string, path: string) => ({
      role: "assistant",
      content: [{ type: "toolCall", name, arguments: { path } }],
    });
    const messages = [
      call("read", "/r/context/tasks/a/base-1/transcript.md"),
      call("write", "skills/x/SKILL.md"),
      call("grep", "/repo/bench/tasks/fix-discount"),
      call("read", "../context/../../repo/bench/tasks/fix-discount/check.mjs"),
      { role: "user", content: "/etc/passwd" },
    ];
    expect(outsidePaths(messages, "/r/harness", ["/r/harness", "/r/context"])).toEqual([
      "/repo/bench/tasks/fix-discount",
      "/repo/bench/tasks/fix-discount/check.mjs",
    ]);
  });

  it("buildContext refuses a rollout whose files would carry the grader output", () => {
    const work = tmp("ws");
    writeFileSync(join(work, "result.json"), '{"ok": true, "totals": {}}');
    const sessions = tmp("sessions");
    expect(() =>
      buildContext({
        dir: join(tmp("ctx"), "context"),
        requests: { "fix-discount": ["почини"] },
        originals: { "fix-discount": tmp("orig") },
        base: baseTree(MODEL),
        rollouts: [
          { task: "fix-discount", label: "base-1", sessionsDir: sessions, workspace: work },
        ],
        checkFiles: [],
        fingerprints: [],
      }),
    ).toThrow(/grader verdict/);
  });
});

describe("tuner harness tree: only data, validated", () => {
  it("the shipped harness is a valid tree; code paths, broken JSON and bad skills are not", () => {
    const base = baseTree(MODEL);
    expect(Object.keys(base)).toContain("lessons.json");
    expect(Object.keys(base).some((p) => p.startsWith("skills/") && p.endsWith("/SKILL.md"))).toBe(
      true,
    );
    expect(validateTree(base)).toEqual([]);

    expect(validateTree({ ...base, "src/index.ts": "x" }).join()).toMatch(/менять нельзя/);
    expect(validateTree({ ...base, "skills/a/../../x.md": "x" }).join()).toMatch(/менять нельзя/);
    expect(validateTree({ ...base, "skills/fix-code/sub/x.md": "x" }).join()).toMatch(
      /менять нельзя/,
    );
    expect(validateTree({ ...base, "lessons.json": "{" }).join()).toMatch(/не JSON/);
    expect(
      validateTree({
        ...base,
        "skills/new-one/SKILL.md": "---\nname: other\ndescription: d\n---\n",
      }).join(),
    ).toMatch(/name должно быть/);
    expect(validateTree({ ...base, "model-delta.md": "x".repeat(2000) }).join()).toMatch(/1500/);
    expect(validateTree({ ...base, "model-delta.md": "check.mjs says" }).join()).toMatch(/marker/);
  });

  it("benchOptionsFor lays out lessons, skills and the delta for a probe", () => {
    const tree: HarnessTree = { ...baseTree(MODEL), "model-delta.md": "  Проверь.  " };
    const o = benchOptionsFor(tree, tmp("probe"));
    expect(readFileSync(o.lessonsFile, "utf8")).toBe(tree["lessons.json"]);
    expect(o.deltaText).toBe("Проверь.");
    expect(Object.values(o.skillFiles).every((files) => "SKILL.md" in files)).toBe(true);
  });
});

describe("train/test split, fixed before tuning", () => {
  it("bench/split.json: disjoint, covers exactly the casual suite, honesty tasks never in train", () => {
    const s = loadSplit();
    const casual = listTasks(undefined, "casual", false).map((t) => t.id);
    expect([...s.train, ...s.test].sort()).toEqual([...casual].sort());
    expect(s.train).toHaveLength(4);
    expect(s.decided).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const honesty = listTasks(undefined, "honesty", false).map((t) => t.id.split("/")[0]!);
    expect(s.train.filter((t) => honesty.includes(t))).toEqual([]);
    expect(() => assertTrainOnly(s, [s.test[0]!])).toThrow(/не из train/);
  });

  it("seeded is deterministic; unstable picks rates nearest 0.5; written once, seeded replaceable once", () => {
    const tasks = ["a", "b", "c", "d", "e"];
    expect(seededSplit(tasks, 2, 7, "2026-10-25")).toEqual(seededSplit(tasks, 2, 7, "2026-10-25"));
    const r = (ok: Record<string, boolean>) => ({
      results: Object.entries(ok).map(([id, v]) => ({ id, ok: v })),
    });
    const reports = [
      r({ a: true, b: true, c: false, d: true, e: true }),
      r({ a: true, b: false, c: false, d: true, e: false }),
      r({ a: true, b: false, c: false, d: false, e: true }),
    ];
    const u = unstableSplit(tasks, reports, 2, "2026-11-01");
    // a и c стабильны; b, d, e на равном расстоянии от 0,5 — по имени.
    expect(u.train).toEqual(["b", "d"]);
    expect(u.test).toContain("a");

    const file = join(tmp("split"), "split.json");
    const seeded = seededSplit(tasks, 2, 7, "2026-10-25");
    writeSplitOnce(seeded, file);
    expect(() => writeSplitOnce(seeded, file)).toThrow(/не перезаписывается/);
    expect(() => writeSplitOnce(u, file)).toThrow(/не перезаписывается/);
    writeSplitOnce(u, file, { replaceSeeded: true });
    expect(loadSplit(file).rule).toMatch(/нестабильные/);
    expect(() => writeSplitOnce(seeded, file, { replaceSeeded: true })).toThrow();
  });
});

describe("harness2 attribution", () => {
  it("Google LLC headers kept, our changes marked, NOTICE entry and licence text present", () => {
    for (const f of ["src/tuner/prompts.ts", "src/tuner/leaks.ts"]) {
      const text = readFileSync(join(PKG, f), "utf8");
      expect(text.startsWith("// Copyright 2026 Google LLC")).toBe(true);
      expect(text).toContain("Licensed under the Apache License, Version 2.0");
      expect(text).toContain("Modified by PRSLOY");
      expect(text).toContain("1cfe254");
    }
    expect(readFileSync(join(APP, "NOTICE.md"), "utf8")).toContain("google-research/harness2");
    expect(readFileSync(join(APP, "licenses", "harness2-Apache-2.0.txt"), "utf8")).toContain(
      "Apache License",
    );
    expect(editorPrompt("INV", "/ctx", 1)).toContain("YOUR DIMENSION: INV");
    expect(editorPrompt("DOM", "/ctx", 1)).toContain("YOUR DIMENSION: DOM");
  });
});

describe("bench --lessons-file / --skills-dir / --delta-file", () => {
  it("the probe runs with the given lessons, skills and delta", () => {
    const dir = tmp("flags");
    const skills = join(dir, "skills", "probe-skill");
    mkdirSync(skills, { recursive: true });
    writeFileSync(
      join(skills, "SKILL.md"),
      "---\nname: probe-skill\ndescription: Проба навыка из папки.\n---\n\nТело.\n",
    );
    writeFileSync(join(dir, "delta.md"), "ДЕЛЬТА-ПРОБЫ: короче.\n");
    writeFileSync(join(dir, "lessons.json"), readFileSync(join(PKG, "lessons", "code.json")));
    const out = join(dir, "out");
    const r = spawnSync(
      process.execPath,
      [
        join(PKG, "scripts", "bench.mts"),
        "--fake",
        "--task",
        "fix-discount",
        "--out",
        out,
        "--lessons-file",
        join(dir, "lessons.json"),
        "--skills-dir",
        join(dir, "skills"),
        "--delta-file",
        join(dir, "delta.md"),
      ],
      { cwd: APP, encoding: "utf8" },
    );
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const sessions = filesUnder(join(out, "sessions"))
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    expect(sessions).toContain("probe-skill");
    expect(sessions).toContain("ДЕЛЬТА-ПРОБЫ");
  }, 120_000);
});

describe("ppc --fake: one Propose–Probe–Compose round end to end", () => {
  it("editors, validator retry, probes, composer, final run, reflector; grader output never reaches a model", async () => {
    const split: Split = {
      version: 1,
      decided: "2026-10-25",
      rule: "seed test",
      train: ["fix-discount", "visit-card"],
      test: ["explain-project"],
    };
    const out = join(tmp("ppc"), "round");
    const result = await runPpc(
      {
        model: MODEL,
        fake: true,
        split,
        k: 1,
        outDir: out,
        timeoutSec: 60,
        sessionTimeoutSec: 60,
      },
      fakeScripts(split.train),
    );
    const byLabel = Object.fromEntries(result.candidates.map((c) => [c.label, c]));
    expect(byLabel["INV-1"]!.status).toBe("retried");
    expect(byLabel["INV-1"]!.changes).toEqual([
      { path: `skills/${FAKE_SKILL}/SKILL.md`, kind: "added" },
    ]);
    expect(byLabel["DOM-1"]!.status).toBe("valid");
    expect(result.composed.changes.map((c) => c.path).sort()).toEqual(
      ["model-delta.md", `skills/${FAKE_SKILL}/SKILL.md`].sort(),
    );
    expect(readTree(join(out, "candidates", "composed", "harness"))["model-delta.md"]).toBe(
      FAKE_DELTA,
    );
    expect(Object.keys(result.train).sort()).toEqual(["DOM-1", "INV-1", "base-1", "final-1"]);
    expect(result.test?.composed.passed).toBe(1);
    expect(result.reflection.experience).toBe("NO_ENTRY");
    expect(result.reflection.edits).toContain("verdict: confounded");

    // Улики только с train; ни отчёта, ни check.mjs в контексте.
    for (const name of ["edit", "compose", "reflect"]) {
      const ctx = join(out, "context", name);
      expect(readdirSync(join(ctx, "tasks")).sort()).toEqual(["fix-discount", "visit-card"]);
      expect(() => assertNoGraderVerdicts(ctx)).not.toThrow();
    }
    const proposal = readFileSync(join(out, "PROPOSAL.md"), "utf8");
    expect(proposal).toContain("+++ b/candidates/composed/harness/model-delta.md");
    expect(proposal).toContain("| INV-1 | retried |");
    // Раунд пишется в новую папку.
    await expect(
      runPpc(
        {
          model: MODEL,
          fake: true,
          split,
          k: 1,
          outDir: out,
          timeoutSec: 60,
          sessionTimeoutSec: 60,
        },
        fakeScripts(split.train),
      ),
    ).rejects.toThrow(/уже использована/);
  }, 180_000);
});
