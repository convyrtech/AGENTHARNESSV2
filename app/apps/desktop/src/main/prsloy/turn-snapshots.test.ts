import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { promptPreview, TurnSnapshots, workspaceKey } from "./turn-snapshots.ts";

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(options: Partial<ConstructorParameters<typeof TurnSnapshots>[0]> = {}) {
  const workspace = tempDir("prsloy-ws-");
  const root = tempDir("prsloy-snap-");
  const snapshots = new TurnSnapshots({ root, gitBinary: "git", ...options });
  const write = (path: string, content: string) => {
    mkdirSync(join(workspace, path, ".."), { recursive: true });
    writeFileSync(join(workspace, path), content);
  };
  const read = (path: string) => readFileSync(join(workspace, path), "utf8");
  const has = (path: string) => existsSync(join(workspace, path));
  return { workspace, root, snapshots, write, read, has };
}

describe("turn snapshots", () => {
  it("restores the workspace to the state before a turn", async () => {
    const { workspace, snapshots, write, read, has } = setup();
    write("index.html", "v1");
    write("src/app.js", "app v1");

    const t1 = await snapshots.beforeTurn(workspace, { prompt: "сделай лендинг\nподробности" });
    expect(t1.record?.turn).toBe(1);
    expect(t1.record?.prompt).toBe("сделай лендинг");
    // Turn 1: agent edits, deletes and creates files.
    write("index.html", "v2");
    rmSync(join(workspace, "src/app.js"));
    write("src/new/feature.js", "new");

    const t2 = await snapshots.beforeTurn(workspace, { prompt: "ещё" });
    expect(t2.record?.turn).toBe(2);
    write("index.html", "v3");

    const result = await snapshots.restore(workspace, t1.record!.id);
    expect(read("index.html")).toBe("v1");
    expect(read("src/app.js")).toBe("app v1");
    expect(has("src/new/feature.js")).toBe(false);
    expect(has("src/new")).toBe(false);
    expect(result.removed).toEqual(["src/new/feature.js"]);
    expect(result.rewritten.sort()).toEqual(["index.html", "src/app.js"]);

    // The pre-undo state was backed up and can be restored again («вернуть»).
    expect(result.backup?.kind).toBe("undo-backup");
    await snapshots.restore(workspace, result.backup!.id);
    expect(read("index.html")).toBe("v3");
    expect(has("src/new/feature.js")).toBe(true);
  });

  it("lists turns newest first and filters by session", async () => {
    const { workspace, snapshots, write } = setup();
    write("a.txt", "1");
    await snapshots.beforeTurn(workspace, { prompt: "one", sessionId: "s1" });
    write("a.txt", "2");
    await snapshots.beforeTurn(workspace, { prompt: "two", sessionId: "s2" });
    expect((await snapshots.list(workspace)).map((r) => r.turn)).toEqual([2, 1]);
    expect((await snapshots.list(workspace, { sessionId: "s1" })).map((r) => r.prompt)).toEqual([
      "one",
    ]);
  });

  it("respects .gitignore and never touches ignored files on restore", async () => {
    const { workspace, snapshots, write, read } = setup();
    write(".gitignore", "build/\n");
    write("build/out.bin", "artifact v1");
    write("node_modules/pkg/index.js", "dep");
    write("main.py", "print(1)");
    const t1 = await snapshots.beforeTurn(workspace);
    write("build/out.bin", "artifact v2");
    write("main.py", "print(2)");
    await snapshots.restore(workspace, t1.record!.id);
    expect(read("main.py")).toBe("print(1)");
    expect(read("build/out.bin")).toBe("artifact v2");
    expect(read("node_modules/pkg/index.js")).toBe("dep");
  });

  it("skips files over the per-file cap and whole turns over the total cap", async () => {
    const small = setup({ maxFileBytes: 10 });
    small.write("big.dat", "x".repeat(50));
    small.write("ok.txt", "ok");
    const t1 = await small.snapshots.beforeTurn(small.workspace);
    expect(t1.record).toBeDefined();
    small.write("big.dat", "y".repeat(50));
    small.write("ok.txt", "changed");
    await small.snapshots.restore(small.workspace, t1.record!.id);
    expect(small.read("ok.txt")).toBe("ok");
    expect(small.read("big.dat")).toBe("y".repeat(50));

    const capped = setup({ maxTotalBytes: 5 });
    capped.write("a.txt", "0123456789");
    const skipped = await capped.snapshots.beforeTurn(capped.workspace);
    expect(skipped.record).toBeUndefined();
    expect(skipped.skipped).toMatchObject({ ok: false, reason: "too_large" });
  });

  it("leaves the user's own git repo untouched", async () => {
    const { workspace, snapshots, write, read } = setup();
    execFileSync("git", ["init", "-q"], { cwd: workspace });
    write("tracked.txt", "v1");
    execFileSync("git", ["add", "tracked.txt"], { cwd: workspace });
    const statusBefore = execFileSync("git", ["status", "--porcelain"], {
      cwd: workspace,
      encoding: "utf8",
    });
    const t1 = await snapshots.beforeTurn(workspace);
    write("tracked.txt", "v2");
    await snapshots.restore(workspace, t1.record!.id);
    expect(read("tracked.txt")).toBe("v1");
    expect(
      execFileSync("git", ["status", "--porcelain"], { cwd: workspace, encoding: "utf8" }),
    ).toBe(statusBefore);
  });

  it("reports a missing workspace instead of throwing", async () => {
    const { snapshots, root } = setup();
    const result = await snapshots.beforeTurn(join(root, "missing"));
    expect(result.skipped).toMatchObject({ ok: false, reason: "not_a_directory" });
  });

  it("keys workspaces case-insensitively on Windows only", () => {
    expect(workspaceKey("C:\\Proj", "win32")).toBe(workspaceKey("c:\\proj", "win32"));
    expect(workspaceKey("/Proj", "linux")).not.toBe(workspaceKey("/proj", "linux"));
    expect(promptPreview("x".repeat(200))).toHaveLength(120);
  });
});
