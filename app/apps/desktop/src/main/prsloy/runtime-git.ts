/**
 * PortableGit on first launch (Windows): the installer ships the original 7-Zip
 * self-extractor (`resources/runtimes/archives/git.7z.exe`, ~60MB) because it is far
 * smaller than any tar.gz of the tree. We unpack it in the background into
 * `userData/runtimes/git` with its own switches (`-y -o<dir>`), report a percentage, and
 * the first agent turn waits for it (bounded) so pi's bash tool has its shell.
 *
 * Unpacks into a temp dir and renames into place, so a half-unpacked tree is never used.
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type GitSetupStatus = "absent" | "installing" | "ready" | "failed";

export type GitSetupState = {
  status: GitSetupStatus;
  /** 0–100 while installing. */
  percent?: number;
  error?: string;
};

export type GitRuntimeOptions = {
  /** Directory that will hold `git/` (userData/runtimes). */
  runtimesRoot: string;
  /** Path to git.7z.exe; undefined on platforms / dev trees without it. */
  archive?: string | undefined;
  /** Version from the vendor manifest; re-extracts when it changes. */
  version?: string | undefined;
  /** File count of the unpacked tree (manifest `gitFiles`) for the percentage. */
  expectedFiles?: number | undefined;
  onChange?: (state: GitSetupState) => void;
  /** Injectable for tests. */
  spawn?: (command: string, args: string[]) => ChildProcess;
  pollMs?: number;
};

const STAMP = ".prsloy-git.json";

function countFiles(root: string): number {
  let count = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) stack.push(join(dir, entry.name));
      else count += 1;
    }
  }
  return count;
}

export class GitRuntime {
  readonly #opts: GitRuntimeOptions;
  #state: GitSetupState = { status: "absent" };
  #running: Promise<GitSetupState> | undefined;

  constructor(options: GitRuntimeOptions) {
    this.#opts = options;
  }

  get dir(): string {
    return join(this.#opts.runtimesRoot, "git");
  }

  state(): GitSetupState {
    return { ...this.#state };
  }

  #set(next: GitSetupState): void {
    this.#state = next;
    this.#opts.onChange?.({ ...next });
  }

  async #stampMatches(): Promise<boolean> {
    if (!existsSync(join(this.dir, "bin", "bash.exe"))) return false;
    if (!this.#opts.version) return true;
    try {
      const stamp = JSON.parse(await readFile(join(this.dir, STAMP), "utf8")) as {
        version?: string;
      };
      return stamp.version === this.#opts.version;
    } catch {
      return false;
    }
  }

  /** Idempotent: resolves when git is ready, absent (nothing to unpack) or failed. */
  ensure(): Promise<GitSetupState> {
    this.#running ??= this.#ensure().finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  async #ensure(): Promise<GitSetupState> {
    if (await this.#stampMatches()) {
      this.#set({ status: "ready" });
      return this.state();
    }
    const archive = this.#opts.archive;
    if (!archive || !existsSync(archive)) {
      // Dev tree with an expanded git/ (no stamp) still counts as ready.
      this.#set(
        existsSync(join(this.dir, "bin", "bash.exe")) ? { status: "ready" } : { status: "absent" },
      );
      return this.state();
    }

    const partial = join(this.#opts.runtimesRoot, `git.partial-${process.pid}`);
    await rm(partial, { recursive: true, force: true });
    await mkdir(this.#opts.runtimesRoot, { recursive: true });
    this.#set({ status: "installing", percent: 0 });

    const expected =
      this.#opts.expectedFiles && this.#opts.expectedFiles > 0 ? this.#opts.expectedFiles : 0;
    const timer = setInterval(() => {
      if (!expected) return;
      const percent = Math.min(99, Math.floor((countFiles(partial) / expected) * 100));
      if (percent !== this.#state.percent) this.#set({ status: "installing", percent });
    }, this.#opts.pollMs ?? 1000);

    try {
      const spawn =
        this.#opts.spawn ??
        ((command: string, args: string[]) =>
          nodeSpawn(command, args, { stdio: "ignore", windowsHide: true }));
      await new Promise<void>((resolve, reject) => {
        const child = spawn(archive, ["-y", `-o${partial}`]);
        child.once("error", reject);
        child.once("exit", (code) =>
          code === 0 ? resolve() : reject(new Error(`PortableGit extractor exited with ${code}`)),
        );
      });
      if (!existsSync(join(partial, "bin", "bash.exe"))) {
        throw new Error("PortableGit unpacked without bin/bash.exe");
      }
      await writeFile(
        join(partial, STAMP),
        `${JSON.stringify({ version: this.#opts.version ?? null, at: new Date().toISOString() })}\n`,
      );
      await rm(this.dir, { recursive: true, force: true });
      await rename(partial, this.dir);
      this.#set({ status: "ready" });
    } catch (error) {
      await rm(partial, { recursive: true, force: true }).catch(() => undefined);
      this.#set({
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearInterval(timer);
    }
    return this.state();
  }

  /** Wait (bounded) until git is no longer installing. True when it is usable. */
  async whenReady(timeoutMs: number): Promise<boolean> {
    if (this.#state.status === "ready") return true;
    const running = this.#running ?? this.ensure();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      running,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    return outcome?.status === "ready";
  }
}
