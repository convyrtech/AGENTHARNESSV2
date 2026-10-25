import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";

const DEFAULTS = {
  secondOpinion: true,
  // RC check (desktop/ui-rc): memory, auto memory, honest exit and web tools on by default
  memory: true,
  autoMemory: true,
  honestExit: true,
  testGuard: false,
  claimCheck: false,
  webTools: true,
} as const;

vi.mock("electron", () => ({ app: { getPath: () => tmpdir() }, ipcMain: { handle: vi.fn() } }));

const { harnessFlagsPath, readHarnessFlags, writeHarnessFlags } =
  await import("./harness-flags.ts");

describe("harness flags (prsloy-harness.json)", () => {
  it("second opinion is on when the file or the flag is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "flags-"));
    expect(readHarnessFlags(harnessFlagsPath(dir))).toEqual({ ...DEFAULTS });
    writeFileSync(harnessFlagsPath(dir), "{not json");
    expect(readHarnessFlags(harnessFlagsPath(dir))).toEqual({ ...DEFAULTS });
  });

  it("writes the exact shape the harness reads and keeps other keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "flags-"));
    const path = harnessFlagsPath(dir);
    writeFileSync(path, JSON.stringify({ other: 1 }));
    expect(writeHarnessFlags(path, { secondOpinion: false })).toEqual({
      ...DEFAULTS,
      secondOpinion: false,
    });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ other: 1, secondOpinion: false });
    expect(writeHarnessFlags(path, { memory: false })).toEqual({
      ...DEFAULTS,
      secondOpinion: false,
      memory: false,
    });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      other: 1,
      secondOpinion: false,
      memory: false,
    });
  });

  it("research/24 flags: autoMemory off | shadow | true, the honesty checks are booleans", () => {
    const path = harnessFlagsPath(mkdtempSync(join(tmpdir(), "flags-")));
    expect(writeHarnessFlags(path, { autoMemory: "shadow", testGuard: true })).toEqual({
      ...DEFAULTS,
      autoMemory: "shadow",
      testGuard: true,
    });
    expect(
      writeHarnessFlags(path, { autoMemory: true, honestExit: true, claimCheck: true }),
    ).toMatchObject({
      autoMemory: true,
      honestExit: true,
      claimCheck: true,
    });
    expect(() => writeHarnessFlags(path, { autoMemory: "yes" })).toThrow();
    expect(() => writeHarnessFlags(path, { autoMemory: false })).toThrow();
    expect(() => writeHarnessFlags(path, { honestExit: "on" })).toThrow();
  });

  it("webTools (issue #23): web_search and web_fetch in «Код», on in the RC, a boolean", () => {
    const path = harnessFlagsPath(mkdtempSync(join(tmpdir(), "flags-")));
    expect(readHarnessFlags(path).webTools).toBe(true);
    expect(writeHarnessFlags(path, { webTools: false })).toEqual({ ...DEFAULTS, webTools: false });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ webTools: false });
    expect(() => writeHarnessFlags(path, { webTools: "on" })).toThrow();
  });

  it("accepts nothing but a boolean", () => {
    const path = harnessFlagsPath(mkdtempSync(join(tmpdir(), "flags-")));
    expect(() => writeHarnessFlags(path, { secondOpinion: "no" })).toThrow();
    expect(() => writeHarnessFlags(path, null)).toThrow();
    expect(() => writeHarnessFlags(path, { memory: 1 })).toThrow();
    expect(() => writeHarnessFlags(path, { other: true })).toThrow();
  });
});
