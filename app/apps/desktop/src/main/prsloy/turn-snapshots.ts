/**
 * «Откатить ход»: snapshot the workspace before every agent turn into a shadow git
 * repo under userData (OpenCode design), restore any earlier turn on demand.
 *
 * - One shadow repo per workspace path: `<root>/<sha256(path)[:16]>/git`, work tree =
 *   the workspace. The user's own `.git` is never touched (git skips `.git` paths).
 * - `add -A` + `write-tree` → a tree hash per turn. The workspace `.gitignore` files
 *   are honoured (plus a base list: node_modules, .venv, …); files over `maxFileBytes`
 *   are excluded; when the remaining set is still over `maxTotalBytes` / `maxFiles` the
 *   turn is not snapshotted.
 * - Restore(N): back up the current state, delete files created since N, rewrite files
 *   changed or deleted since N. Ignored files (node_modules, .venv, …) are untouched.
 *
 * Known limit: nested git repos inside the workspace are stored as gitlinks, so their
 * contents are not snapshotted.
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type TurnRecord = {
  id: string;
  /** 1-based, monotonic per workspace. */
  turn: number;
  tree: string;
  createdAt: string;
  sessionId?: string;
  /** First line of the user prompt (≤120 chars) for the list UI. */
  prompt?: string;
  kind: "turn" | "undo-backup";
};

export type TrackResult =
  | { ok: true; tree: string; excludedLarge: string[] }
  | { ok: false; reason: "too_large" | "not_a_directory" | "git_failed"; detail?: string };

export type RestoreResult = {
  restoredTo: TurnRecord;
  /** Snapshot of the state right before the restore (lets the UI offer «вернуть»). */
  backup?: TurnRecord;
  rewritten: string[];
  removed: string[];
};

export type TurnSnapshotsOptions = {
  root: string;
  /** git executable (bundled PortableGit on Windows). */
  gitBinary: string;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxFiles?: number;
  /** Records kept per workspace (oldest dropped). */
  maxRecords?: number;
  platform?: NodeJS.Platform;
};

const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_FILES = 25_000;
const DEFAULT_MAX_RECORDS = 300;

/** Paths never worth snapshotting even when a project forgot to ignore them. */
const BASE_EXCLUDES = [
  "node_modules/",
  ".venv/",
  "venv/",
  "__pycache__/",
  ".pytest_cache/",
  ".mypy_cache/",
  ".next/",
  ".turbo/",
  ".cache/",
  "*.pyc",
  ".DS_Store",
  "Thumbs.db",
];

function escapeExcludePath(path: string): string {
  // Anchored literal path for gitignore syntax.
  return `/${path.replace(/[\\*?[\]!#]/g, (c) => `\\${c}`).replace(/^\s|\s$/g, (c) => `\\${c}`)}`;
}

export function workspaceKey(workspace: string, platform: NodeJS.Platform = process.platform) {
  const normalized = resolve(workspace).replace(/[\\/]+$/u, "");
  const keyed = platform === "win32" ? normalized.toLowerCase() : normalized;
  return createHash("sha256").update(keyed).digest("hex").slice(0, 16);
}

export function promptPreview(message: string): string {
  const line = message.trim().split(/\r?\n/u)[0] ?? "";
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

function devNull(platform: NodeJS.Platform): string {
  return platform === "win32" ? "NUL" : "/dev/null";
}

export class TurnSnapshots {
  readonly #root: string;
  readonly #git: string;
  readonly #maxFileBytes: number;
  readonly #maxTotalBytes: number;
  readonly #maxFiles: number;
  readonly #maxRecords: number;
  readonly #platform: NodeJS.Platform;
  readonly #queues = new Map<string, Promise<unknown>>();

  constructor(options: TurnSnapshotsOptions) {
    this.#root = options.root;
    this.#git = options.gitBinary;
    this.#maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.#maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    this.#maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    this.#maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    this.#platform = options.platform ?? process.platform;
  }

  repoDir(workspace: string): string {
    return join(this.#root, workspaceKey(workspace, this.#platform));
  }

  /** Serialize operations per workspace (a turn and an undo must not interleave). */
  #exclusive<T>(workspace: string, task: () => Promise<T>): Promise<T> {
    const key = this.repoDir(workspace);
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.#queues.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }

  #run(
    workspace: string,
    args: string[],
    options: { input?: string; maxBuffer?: number } = {},
  ): Promise<string> {
    const gitDir = join(this.repoDir(workspace), "git");
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      // Inherited GIT_* (GIT_DIR, GIT_INDEX_FILE, …) would redirect us into the user's repo.
      if (!key.toUpperCase().startsWith("GIT_")) env[key] = value;
    }
    env.GIT_DIR = gitDir;
    env.GIT_WORK_TREE = resolve(workspace);
    env.GIT_CONFIG_NOSYSTEM = "1";
    env.GIT_CONFIG_GLOBAL = devNull(this.#platform);
    env.GIT_TERMINAL_PROMPT = "0";
    env.GIT_OPTIONAL_LOCKS = "0";
    const fullArgs = [
      "-c",
      "core.autocrlf=false",
      "-c",
      "core.safecrlf=false",
      "-c",
      "core.longpaths=true",
      "-c",
      "core.quotepath=false",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "gc.auto=0",
      ...args,
    ];
    return new Promise((resolvePromise, reject) => {
      const child = execFile(
        this.#git,
        fullArgs,
        {
          cwd: resolve(workspace),
          env,
          windowsHide: true,
          maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
          encoding: "utf8",
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(`git ${args[0]} failed: ${String(stderr || error.message).trim()}`));
            return;
          }
          resolvePromise(String(stdout));
        },
      );
      if (options.input !== undefined) {
        child.stdin?.end(options.input);
      }
    });
  }

  async #ensureRepo(workspace: string): Promise<void> {
    const dir = this.repoDir(workspace);
    const gitDir = join(dir, "git");
    if (existsSync(join(gitDir, "HEAD"))) return;
    await mkdir(dir, { recursive: true });
    await this.#run(workspace, ["init", "--quiet"]);
    await writeFile(join(dir, "workspace.txt"), `${resolve(workspace)}\n`, "utf8");
  }

  async #listCandidates(workspace: string): Promise<string[]> {
    const out = await this.#run(workspace, [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ]);
    return [...new Set(out.split("\0").filter(Boolean))];
  }

  async #track(workspace: string): Promise<TrackResult> {
    const root = resolve(workspace);
    try {
      if (!(await lstat(root)).isDirectory()) return { ok: false, reason: "not_a_directory" };
    } catch {
      return { ok: false, reason: "not_a_directory" };
    }
    try {
      await this.#ensureRepo(workspace);
      const gitDir = join(this.repoDir(workspace), "git");
      // Base excludes first so ls-files does not walk node_modules & co.
      await mkdir(join(gitDir, "info"), { recursive: true });
      await writeFile(join(gitDir, "info", "exclude"), `${BASE_EXCLUDES.join("\n")}\n`, "utf8");

      const candidates = await this.#listCandidates(workspace);
      const large: string[] = [];
      let total = 0;
      let count = 0;
      for (const path of candidates) {
        let size = 0;
        try {
          const stat = await lstat(join(root, path));
          if (!stat.isFile()) continue;
          size = stat.size;
        } catch {
          continue; // deleted since listing → add -A records the deletion
        }
        if (size > this.#maxFileBytes) {
          large.push(path);
          continue;
        }
        total += size;
        count += 1;
      }
      if (total > this.#maxTotalBytes || count > this.#maxFiles) {
        return {
          ok: false,
          reason: "too_large",
          detail: `${count} files, ${Math.round(total / 1024 / 1024)} MB`,
        };
      }
      await writeFile(
        join(gitDir, "info", "exclude"),
        `${[...BASE_EXCLUDES, ...large.map(escapeExcludePath)].join("\n")}\n`,
        "utf8",
      );
      if (large.length > 0) {
        // Previously small, now large: stop tracking (ignored files stay in the index otherwise).
        await this.#run(
          workspace,
          [
            "rm",
            "--cached",
            "--quiet",
            "--ignore-unmatch",
            "--pathspec-from-file=-",
            "--pathspec-file-nul",
          ],
          { input: `${large.join("\0")}\0` },
        );
      }
      await this.#run(workspace, ["add", "--all"]);
      const tree = (await this.#run(workspace, ["write-tree"])).trim();
      return { ok: true, tree, excludedLarge: large };
    } catch (error) {
      return {
        ok: false,
        reason: "git_failed",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async #readRecords(workspace: string): Promise<TurnRecord[]> {
    try {
      const parsed: unknown = JSON.parse(
        await readFile(join(this.repoDir(workspace), "turns.json"), "utf8"),
      );
      return Array.isArray(parsed) ? (parsed as TurnRecord[]) : [];
    } catch {
      return [];
    }
  }

  async #writeRecords(workspace: string, records: TurnRecord[]): Promise<void> {
    const path = join(this.repoDir(workspace), "turns.json");
    const tmp = `${path}.tmp-${process.pid}`;
    await writeFile(tmp, `${JSON.stringify(records, null, 2)}\n`, "utf8");
    await rename(tmp, path);
  }

  async #append(
    workspace: string,
    tree: string,
    meta: { kind: TurnRecord["kind"]; sessionId?: string | undefined; prompt?: string | undefined },
  ): Promise<TurnRecord> {
    const records = await this.#readRecords(workspace);
    const lastTurn = records.reduce((max, r) => Math.max(max, r.turn), 0);
    const record: TurnRecord = {
      id: randomUUID(),
      turn: meta.kind === "turn" ? lastTurn + 1 : lastTurn,
      tree,
      createdAt: new Date().toISOString(),
      kind: meta.kind,
      ...(meta.sessionId ? { sessionId: meta.sessionId } : {}),
      ...(meta.prompt ? { prompt: promptPreview(meta.prompt) } : {}),
    };
    records.push(record);
    await this.#writeRecords(workspace, records.slice(-this.#maxRecords));
    return record;
  }

  /** Snapshot taken right before an agent turn. Never throws. */
  beforeTurn(
    workspace: string,
    meta: { prompt?: string; sessionId?: string } = {},
  ): Promise<{ record?: TurnRecord; skipped?: TrackResult }> {
    return this.#exclusive(workspace, async () => {
      const tracked = await this.#track(workspace);
      if (!tracked.ok) return { skipped: tracked };
      const record = await this.#append(workspace, tracked.tree, {
        kind: "turn",
        sessionId: meta.sessionId,
        prompt: meta.prompt,
      });
      return { record };
    });
  }

  /** Turn records, newest first. */
  async list(workspace: string, options: { sessionId?: string } = {}): Promise<TurnRecord[]> {
    const records = await this.#readRecords(workspace);
    return records.filter((r) => !options.sessionId || r.sessionId === options.sessionId).reverse();
  }

  /** Restore the workspace to the snapshot `recordId` (the state before that turn). */
  restore(workspace: string, recordId: string): Promise<RestoreResult> {
    return this.#exclusive(workspace, async () => {
      const records = await this.#readRecords(workspace);
      const target = records.find((r) => r.id === recordId);
      if (!target) throw new Error("Snapshot not found");
      const root = resolve(workspace);

      const current = await this.#track(workspace);
      if (!current.ok) {
        throw new Error(`Cannot snapshot current state before undo (${current.reason})`);
      }
      const backup =
        current.tree === target.tree
          ? undefined
          : await this.#append(workspace, current.tree, { kind: "undo-backup" });

      const diff = await this.#run(workspace, [
        "diff-tree",
        "-r",
        "--no-renames",
        "--name-status",
        "-z",
        target.tree,
        current.tree,
      ]);
      const parts = diff.split("\0").filter(Boolean);
      const added: string[] = [];
      const changed: string[] = [];
      for (let i = 0; i + 1 < parts.length; i += 2) {
        const status = parts[i]!;
        const path = parts[i + 1]!;
        if (status.startsWith("A")) added.push(path);
        else changed.push(path); // M, D, T: present in target
      }

      const removed: string[] = [];
      for (const path of added) {
        const absolute = resolve(root, path);
        const rel = relative(root, absolute);
        if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue;
        try {
          await rm(absolute, { force: true });
          removed.push(path);
          await this.#pruneEmptyDirs(root, dirname(absolute));
        } catch {
          // best-effort: a locked file stays; the restore still rewrites the rest
        }
      }

      await this.#run(workspace, ["read-tree", target.tree]);
      if (changed.length > 0) {
        await this.#run(workspace, ["checkout-index", "--force", "-z", "--stdin"], {
          input: `${changed.join("\0")}\0`,
        });
      }
      return {
        restoredTo: target,
        ...(backup ? { backup } : {}),
        rewritten: changed,
        removed,
      };
    });
  }

  async #pruneEmptyDirs(root: string, from: string): Promise<void> {
    let dir = from;
    while (dir.startsWith(`${root}${sep}`)) {
      try {
        if ((await readdir(dir)).length > 0) return;
        await rmdir(dir);
      } catch {
        return;
      }
      dir = dirname(dir);
    }
  }
}
