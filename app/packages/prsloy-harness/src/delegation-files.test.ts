import { mkdtemp, writeFile, link, rm, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { readDelegatedFiles, delegatedDiff, delegatedDigest } from "./delegation-files.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "prsloy-delegated-files-"));
  roots.push(root);
  return root;
}
describe("delegated evidence", () => {
  it("includes new files and detects changes since review", async () => {
    const root = await fixture();
    const before = await readDelegatedFiles(root, ["new.txt"]);
    await writeFile(join(root, "new.txt"), "actual change");
    const after = await readDelegatedFiles(root, ["new.txt"]);
    expect(delegatedDiff(before, after)).toContain("+actual change");
    expect(delegatedDiff(after, after)).toBe("");
    expect(delegatedDigest(before)).not.toBe(delegatedDigest(after));
  });
  it("rejects traversal, hardlinks and junctions before reading", async () => {
    const root = await fixture();
    await writeFile(join(root, "source"), "secret");
    await link(join(root, "source"), join(root, "alias"));
    await expect(readDelegatedFiles(root, ["../source"])).rejects.toThrow();
    await expect(readDelegatedFiles(root, ["alias"])).rejects.toThrow("plain project files");
    await mkdir(join(root, "folder"));
    await symlink(join(root, "folder"), join(root, "junction"), "junction");
    await expect(readDelegatedFiles(root, ["junction/new"])).rejects.toThrow();
  });
  it("does not silently review a truncated or binary scope", async () => {
    const root = await fixture();
    await writeFile(join(root, "binary"), Buffer.from([0, 1, 2]));
    await expect(readDelegatedFiles(root, ["binary"])).rejects.toThrow("text limit");
    await writeFile(join(root, "large"), "a".repeat(200_001));
    await expect(readDelegatedFiles(root, ["large"])).rejects.toThrow("too large");
  });
});
