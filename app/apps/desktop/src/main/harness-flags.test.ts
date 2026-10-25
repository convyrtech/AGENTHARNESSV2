import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("electron", () => ({ app: { getPath: () => tmpdir() }, ipcMain: { handle: vi.fn() } }));

const { harnessFlagsPath, readHarnessFlags, writeHarnessFlags } =
  await import("./harness-flags.ts");

describe("harness flags (prsloy-harness.json)", () => {
  it("second opinion is on when the file or the flag is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "flags-"));
    expect(readHarnessFlags(harnessFlagsPath(dir))).toEqual({ secondOpinion: true });
    writeFileSync(harnessFlagsPath(dir), "{not json");
    expect(readHarnessFlags(harnessFlagsPath(dir))).toEqual({ secondOpinion: true });
  });

  it("writes the exact shape the harness reads and keeps other keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "flags-"));
    const path = harnessFlagsPath(dir);
    writeFileSync(path, JSON.stringify({ other: 1 }));
    expect(writeHarnessFlags(path, { secondOpinion: false })).toEqual({ secondOpinion: false });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ other: 1, secondOpinion: false });
    expect(writeHarnessFlags(path, { secondOpinion: true })).toEqual({ secondOpinion: true });
  });

  it("accepts nothing but a boolean", () => {
    const path = harnessFlagsPath(mkdtempSync(join(tmpdir(), "flags-")));
    expect(() => writeHarnessFlags(path, { secondOpinion: "no" })).toThrow();
    expect(() => writeHarnessFlags(path, null)).toThrow();
  });
});
