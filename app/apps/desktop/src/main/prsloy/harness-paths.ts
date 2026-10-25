/**
 * Where the prsloy-harness pi package lives, so the Agent Host loads its extensions
 * (loop detector, budgets, bash timeout, output limits, post-edit checks) for every
 * session.
 *
 * Contract with the harness stream (`app/packages/prsloy-harness`):
 * - the package dir is a pi package: `package.json` with `"pi": { "extensions": [...] }`
 *   (or an `extensions/` dir / `index.ts`), loadable by pi from a local path;
 * - dev: resolved from the monorepo; packaged: shipped to `resources/prsloy-harness`
 *   (electron-builder `extraResources`, to be added when the package lands);
 * - `PRSLOY_HARNESS_DIR` overrides both (tests, local experiments);
 * - `PRSLOY_HARNESS=0` disables loading.
 *
 * The host receives the list via `PRSLOY_HARNESS_EXTENSIONS` (JSON array) and passes it
 * to `createPixRuntime({ extensionPaths })`.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const HARNESS_PACKAGE_DIR_NAME = "prsloy-harness";

export function harnessCandidateDirs(options: {
  env: NodeJS.ProcessEnv;
  resourcesPath?: string | undefined;
  mainModuleUrl?: string | undefined;
}): string[] {
  const explicit = options.env.PRSLOY_HARNESS_DIR?.trim();
  if (explicit) return [resolve(explicit)];
  const out: string[] = [];
  if (options.resourcesPath) out.push(join(options.resourcesPath, HARNESS_PACKAGE_DIR_NAME));
  if (options.mainModuleUrl) {
    try {
      // dist/main/main.mjs → apps/desktop → app/packages/prsloy-harness
      const mainDir = dirname(fileURLToPath(options.mainModuleUrl));
      out.push(resolve(mainDir, "..", "..", "..", "..", "packages", HARNESS_PACKAGE_DIR_NAME));
    } catch {
      // ignore
    }
  }
  return out;
}

/** First candidate that looks like a pi package. Empty when absent or disabled. */
export function resolveHarnessExtensions(options: {
  env: NodeJS.ProcessEnv;
  resourcesPath?: string | undefined;
  mainModuleUrl?: string | undefined;
  exists?: (path: string) => boolean;
}): string[] {
  if (options.env.PRSLOY_HARNESS === "0") return [];
  const exists = options.exists ?? existsSync;
  for (const dir of harnessCandidateDirs(options)) {
    if (exists(join(dir, "package.json"))) return [dir];
  }
  return [];
}
