import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { GitRuntime, type GitSetupState } from "./runtime-git.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "prsloy-gitrt-"));
  dirs.push(dir);
  return dir;
}

/** A stand-in for PortableGit's SFX: `-y -o<dir>` unpacks N files incl. bin/bash.exe. */
function fakeSfx(
  dir: string,
  options: { files?: number; exitCode?: number; noBash?: boolean } = {},
) {
  const path = join(dir, "git.7z.exe");
  const files = options.files ?? 20;
  writeFileSync(
    path,
    `#!/bin/sh
out=""
for a in "$@"; do case "$a" in -o*) out="\${a#-o}";; esac; done
[ "$1" = "-y" ] || exit 9
mkdir -p "$out/bin" "$out/usr/bin"
${options.noBash ? "" : 'echo bash > "$out/bin/bash.exe"'}
i=0; while [ $i -lt ${files} ]; do echo $i > "$out/usr/bin/f$i"; i=$((i+1)); done
exit ${options.exitCode ?? 0}
`,
  );
  chmodSync(path, 0o755);
  return path;
}

describe.skipIf(process.platform === "win32")("GitRuntime", () => {
  it("unpacks the self-extractor in the background, reports progress, stamps the version", async () => {
    const root = tempDir();
    const states: GitSetupState[] = [];
    const runtime = new GitRuntime({
      runtimesRoot: join(root, "runtimes"),
      archive: fakeSfx(root, { files: 50 }),
      version: "2.51.0",
      expectedFiles: 51,
      pollMs: 1,
      onChange: (state) => states.push(state),
    });
    const done = await runtime.ensure();
    expect(done).toEqual({ status: "ready" });
    expect(states[0]).toEqual({ status: "installing", percent: 0 });
    expect(existsSync(join(root, "runtimes", "git", "bin", "bash.exe"))).toBe(true);
    expect(
      JSON.parse(readFileSync(join(root, "runtimes", "git", ".prsloy-git.json"), "utf8")).version,
    ).toBe("2.51.0");
    // No partial dirs left behind.
    expect(existsSync(join(root, "runtimes", `git.partial-${process.pid}`))).toBe(false);

    // Second launch: stamp matches → ready without running the extractor.
    const again = new GitRuntime({
      runtimesRoot: join(root, "runtimes"),
      archive: join(root, "missing.exe"),
      version: "2.51.0",
    });
    expect(await again.ensure()).toEqual({ status: "ready" });
  });

  it("re-extracts on a version change and keeps the old tree until the new one is complete", async () => {
    const root = tempDir();
    const runtimesRoot = join(root, "runtimes");
    mkdirSync(join(runtimesRoot, "git", "bin"), { recursive: true });
    writeFileSync(join(runtimesRoot, "git", "bin", "bash.exe"), "old");
    writeFileSync(
      join(runtimesRoot, "git", ".prsloy-git.json"),
      JSON.stringify({ version: "2.50.0" }),
    );
    const runtime = new GitRuntime({ runtimesRoot, archive: fakeSfx(root), version: "2.51.0" });
    expect((await runtime.ensure()).status).toBe("ready");
    expect(readFileSync(join(runtimesRoot, "git", "bin", "bash.exe"), "utf8").trim()).toBe("bash");
  });

  it("reports failure and leaves no half-unpacked tree", async () => {
    const root = tempDir();
    const runtimesRoot = join(root, "runtimes");
    const failing = new GitRuntime({ runtimesRoot, archive: fakeSfx(root, { exitCode: 2 }) });
    expect(await failing.ensure()).toMatchObject({ status: "failed" });
    expect(existsSync(join(runtimesRoot, "git"))).toBe(false);

    const noBash = new GitRuntime({ runtimesRoot, archive: fakeSfx(root, { noBash: true }) });
    expect(await noBash.ensure()).toMatchObject({
      status: "failed",
      error: expect.stringContaining("bash.exe"),
    });
    expect(await noBash.whenReady(50)).toBe(false);
  });

  it("is absent without an archive (non-Windows / dev) and whenReady is bounded", async () => {
    const root = tempDir();
    const runtime = new GitRuntime({ runtimesRoot: join(root, "runtimes") });
    expect(await runtime.ensure()).toEqual({ status: "absent" });

    const slow = new GitRuntime({
      runtimesRoot: join(root, "slow"),
      archive: fakeSfx(root),
      spawn: () => {
        // Never exits.
        return new EventEmitter() as never;
      },
    });
    const started = Date.now();
    expect(await slow.whenReady(30)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(slow.state().status).toBe("installing");
  });
});
