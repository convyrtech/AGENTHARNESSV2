import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { venvPython } from "./env.ts";
import { DESIGN_PACKAGES, findEdge, PipProgress, readToolsStamp, toolsReady } from "./setup.ts";

describe("PipProgress", () => {
  it("sums finished wheels so the bar spans the whole install", () => {
    const p = new PipProgress();
    expect(p.line("Collecting pillow==13.0.0")).toBeUndefined();
    expect(p.line("Progress 100 of 300")).toBe(100);
    expect(p.line("Progress 300 of 300")).toBe(300);
    expect(p.line("Progress 50 of 1000")).toBe(350);
    expect(p.line("  Progress 1000 of 1000")).toBe(1300);
    // same-size next file: the counter going back still means a new file
    expect(p.line("Progress 10 of 1000")).toBe(1310);
  });
});

describe("toolsReady", () => {
  it("needs a stamp for exactly the pinned packages and a venv python", () => {
    const root = mkdtempSync(join(tmpdir(), "design-setup-"));
    const venv = join(root, "venv");
    expect(toolsReady(root, venv)).toBe(false);
    writeFileSync(
      join(root, "tools.json"),
      JSON.stringify({ packages: [...DESIGN_PACKAGES], python: "/py" }),
    );
    expect(toolsReady(root, venv)).toBe(false);
    mkdirSync(join(venvPython(venv), ".."), { recursive: true });
    writeFileSync(venvPython(venv), "");
    expect(toolsReady(root, venv)).toBe(true);
    writeFileSync(
      join(root, "tools.json"),
      JSON.stringify({ packages: ["pillow==1"], python: "/py" }),
    );
    expect(toolsReady(root, venv)).toBe(false);
    writeFileSync(join(root, "tools.json"), "{");
    expect(readToolsStamp(root)).toBeUndefined();
  });
});

describe("findEdge", () => {
  it("finds a per-user Edge install", () => {
    const root = mkdtempSync(join(tmpdir(), "design-edge-"));
    const exe = join(root, "Microsoft", "Edge", "Application", "msedge.exe");
    mkdirSync(join(exe, ".."), { recursive: true });
    writeFileSync(exe, "");
    expect(findEdge({ LOCALAPPDATA: root })).toBe(exe);
    expect(findEdge({})).toBeUndefined();
  });
});

describe("design-lock.json", () => {
  it("pins the same packages the first-use install asks for", () => {
    const lock = JSON.parse(
      readFileSync(join(import.meta.dirname, "../../../design-lock.json"), "utf8"),
    ) as { packages: string[] };
    expect(lock.packages).toEqual([...DESIGN_PACKAGES]);
  });
});
