// #70: рабочие папки задач стенда — вне репо; файлы описания выше рабочей папки Pi подмешал бы агенту.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { benchWorkRoot, contextFilesAbove } from "../bench/run.ts";

const root = mkdtempSync(join(tmpdir(), "prsloy-bench-iso-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("bench work folder (#70)", () => {
  it("finds AGENTS.md / CLAUDE.md in the folder and above", () => {
    const repo = join(root, "repo");
    const deep = join(repo, "bench-out", "run", "work");
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(repo, "AGENTS.md"), "dev rules\n");
    writeFileSync(join(repo, "bench-out", "CLAUDE.md"), "x\n");
    expect(contextFilesAbove(deep)).toEqual([
      join(repo, "bench-out", "CLAUDE.md"),
      join(repo, "AGENTS.md"),
    ]);
  });

  it("refuses a work folder under such files and names them", () => {
    const repo = join(root, "repo2");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "AGENTS.md"), "dev rules\n");
    expect(() => benchWorkRoot(join(repo, "work"))).toThrow(/AGENTS\.md.*--work-dir/s);
  });

  it("a clean folder is used as is", () => {
    const clean = join(root, "clean", "work");
    expect(contextFilesAbove(root)).toEqual([]);
    expect(benchWorkRoot(clean)).toBe(clean);
  });
});
