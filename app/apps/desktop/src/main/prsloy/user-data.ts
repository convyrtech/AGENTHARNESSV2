/**
 * Installed PRSLOY keeps its profile in `<appData>/PRSLOY` (productName). The first alpha
 * builds used Electron's default, the package name: `<appData>/@zeno/desktop`. The first
 * launch of a newer build moves that profile over once.
 *
 * - An explicit `--user-data-dir` (tests, smoke) and dev builds are left alone.
 * - The move is a rename (same volume: atomic, keeps ACLs). When that fails (a file in
 *   use, another volume) the tree is copied and the old one kept with a marker file.
 * - Absolute paths into the old profile inside its small JSON files are rewritten.
 * - Managed runtimes are re-provisioned: the Python venv records its interpreter path.
 * - The key directory's user-only ACL is re-applied by bootstrapPrsloy on every start.
 */
import {
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const PRSLOY_USER_DATA_NAME = "PRSLOY";
export const LEGACY_USER_DATA_SEGMENTS = ["@zeno", "desktop"] as const;
export const MIGRATED_MARKER = "MOVED-TO-PRSLOY.txt";

export type UserDataMigration =
  | { status: "none" }
  | { status: "moved" | "copied"; from: string; to: string; rewrittenFiles: string[] }
  | { status: "failed"; from: string; to: string; error: string };

/** JSON files that may hold absolute paths into the profile (relative to its root). */
const PATH_BEARING_JSON = ["zeno-desktop.json", join("prsloy", "state.json")];

function escapeForJson(path: string): string {
  return JSON.stringify(path).slice(1, -1);
}

function rewritePaths(root: string, from: string, to: string): string[] {
  const rewritten: string[] = [];
  const candidates = [
    ...PATH_BEARING_JSON.map((rel) => join(root, rel)),
    ...listJson(join(root, "agent")),
  ];
  for (const file of candidates) {
    try {
      if (!existsSync(file) || statSync(file).size > 4 * 1024 * 1024) continue;
      const text = readFileSync(file, "utf8");
      let next = text;
      for (const [a, b] of [
        [escapeForJson(from), escapeForJson(to)],
        [from, to],
      ] as const) {
        next = next.split(a).join(b);
      }
      if (next !== text) {
        writeFileSync(file, next);
        rewritten.push(file);
      }
    } catch {
      // best effort: a stale path only costs a recent-session entry
    }
  }
  return rewritten;
}

function listJson(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

/** Runtimes re-provision (async, after the window) instead of trusting moved venv paths. */
function invalidateRuntimes(root: string): void {
  for (const rel of [join("runtimes", ".provisioned.json"), join("runtimes", "python-venv")]) {
    rmSync(join(root, rel), { recursive: true, force: true });
  }
}

export function migrateLegacyUserData(options: {
  legacy: string;
  target: string;
  /** Injectable for tests (simulate a failed rename). */
  rename?: (from: string, to: string) => void;
}): UserDataMigration {
  const { legacy, target } = options;
  if (existsSync(target) || !existsSync(legacy)) return { status: "none" };
  if (existsSync(join(legacy, MIGRATED_MARKER))) return { status: "none" };
  let status: "moved" | "copied" = "moved";
  try {
    try {
      (options.rename ?? renameSync)(legacy, target);
      // `<appData>/@zeno` is left empty: drop it (never anything else in it).
      try {
        if (readdirSync(dirname(legacy)).length === 0) rmSync(dirname(legacy), { recursive: true });
      } catch {
        // leave it
      }
    } catch {
      status = "copied";
      cpSync(legacy, target, { recursive: true, errorOnExist: false, force: false });
      writeFileSync(
        join(legacy, MIGRATED_MARKER),
        `This profile was copied to ${target} and is no longer used.\n`,
      );
    }
    invalidateRuntimes(target);
    const rewrittenFiles = rewritePaths(target, legacy, target);
    return { status, from: legacy, to: target, rewrittenFiles };
  } catch (error) {
    return {
      status: "failed",
      from: legacy,
      to: target,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Where userData should live, or undefined to keep Electron's choice (dev builds, an
 * explicit --user-data-dir).
 */
export function prsloyUserDataDir(options: {
  appData: string;
  packaged: boolean;
  explicitUserDataDir: boolean;
}): { target: string; legacy: string } | undefined {
  if (!options.packaged || options.explicitUserDataDir) return undefined;
  return {
    target: join(options.appData, PRSLOY_USER_DATA_NAME),
    legacy: join(options.appData, ...LEGACY_USER_DATA_SEGMENTS),
  };
}
