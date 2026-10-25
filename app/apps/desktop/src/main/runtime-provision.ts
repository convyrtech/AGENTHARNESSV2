/**
 * WorkBuddy-style managed runtimes:
 * - Ship compressed archives in app Resources/runtimes/archives
 * - First launch extract into userData/runtimes/{version}/
 * - Isolate npm prefix + Python venv so agent packages never touch the host
 *
 * Dev: expanded apps/desktop/runtimes/current/{node,python} is used when present
 * (no extract) so `pnpm runtimes:fetch` stays zero-friction.
 */
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type BundledRuntimeManifest,
  type BundledRuntimeRoots,
  getBundledNodeExecutable,
  getBundledPythonExecutable,
  rootsFromRuntimeRoot,
} from "./bundled-runtimes.ts";

export type VendorRuntimeLayout = {
  /** Resources/runtimes or apps/desktop/runtimes/current */
  vendorRoot: string;
  /** Expanded node/python ready to use (dev). */
  expanded?: BundledRuntimeRoots;
  /** Packaged archives to extract into userData. */
  archives?: {
    node?: string;
    python?: string;
    /**
     * Windows: PortableGit self-extractor (bash for the agent, git for turn snapshots).
     * Not unpacked here: `prsloy/runtime-git.ts` does it in the background.
     */
    git?: string;
    /** Windows: rg.exe / fd.exe for pi grep/find. */
    tools?: string;
    manifest: BundledRuntimeManifest;
  };
};

export type ProvisionedRuntimeLayout = {
  roots: BundledRuntimeRoots;
  /** Absolute npm prefix for agent/global-style installs. */
  npmPrefix: string;
  /** Absolute Python venv root (bin/python inside). */
  pythonVenv: string;
  /** True when roots came from userData extract (not dev expanded tree). */
  provisioned: boolean;
  source: "userData" | "vendor-expanded";
};

export type ProvisionStamp = {
  node?: string;
  python?: string;
  git?: string;
  pythonReleaseTag?: string;
  key?: string;
  provisionedAt: string;
};

const STAMP_NAME = ".provisioned.json";

/**
 * Locate vendor runtimes: packaged archives and/or expanded dev tree.
 */
export function resolveVendorRuntimeLayout(options: {
  resourcesPath?: string;
  mainModuleUrl?: string;
  /** Test override. */
  explicitVendorRoot?: string;
}): VendorRuntimeLayout | undefined {
  const candidates: string[] = [];
  if (options.explicitVendorRoot?.trim()) {
    candidates.push(options.explicitVendorRoot.trim());
  }
  if (options.resourcesPath?.trim()) {
    candidates.push(join(options.resourcesPath.trim(), "runtimes"));
  }
  if (options.mainModuleUrl) {
    try {
      const mainDir = dirname(fileURLToPath(options.mainModuleUrl));
      candidates.push(join(mainDir, "..", "..", "runtimes", "current"));
      candidates.push(join(mainDir, "..", "runtimes", "current"));
    } catch {
      // ignore
    }
  }
  candidates.push(join(process.cwd(), "runtimes", "current"));
  candidates.push(join(process.cwd(), "apps", "desktop", "runtimes", "current"));

  for (const vendorRoot of candidates) {
    if (!vendorRoot || !existsSync(vendorRoot)) continue;
    const expanded = rootsFromRuntimeRoot(vendorRoot);
    const archivesDir = join(vendorRoot, "archives");
    const manifestPath = join(vendorRoot, "manifest.json");
    const nodeArchive = join(archivesDir, "node.tar.gz");
    const pythonArchive = join(archivesDir, "python.tar.gz");
    const gitArchive = join(archivesDir, "git.7z.exe");
    const toolsArchive = join(archivesDir, "tools.tar.gz");
    const hasArchives =
      existsSync(archivesDir) && (existsSync(nodeArchive) || existsSync(pythonArchive));
    const manifest = readManifestFile(manifestPath);

    if (!expanded && !hasArchives) continue;

    return {
      vendorRoot,
      ...(expanded ? { expanded } : {}),
      ...(hasArchives
        ? {
            archives: {
              ...(existsSync(nodeArchive) ? { node: nodeArchive } : {}),
              ...(existsSync(pythonArchive) ? { python: pythonArchive } : {}),
              ...(existsSync(gitArchive) ? { git: gitArchive } : {}),
              ...(existsSync(toolsArchive) ? { tools: toolsArchive } : {}),
              manifest: manifest ?? {},
            },
          }
        : {}),
    };
  }
  return undefined;
}

function readManifestFile(path: string): BundledRuntimeManifest | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object") return undefined;
    return parsed as BundledRuntimeManifest;
  } catch {
    return undefined;
  }
}

export function userRuntimesRoot(userDataPath: string): string {
  return join(userDataPath, "runtimes");
}

export function provisionStampPath(userDataPath: string): string {
  return join(userRuntimesRoot(userDataPath), STAMP_NAME);
}

export function npmPrefixDir(userDataPath: string): string {
  return join(userRuntimesRoot(userDataPath), "npm-prefix");
}

export function pythonVenvDir(userDataPath: string): string {
  return join(userRuntimesRoot(userDataPath), "python-venv");
}

/**
 * Whether userData extract matches vendor versions and binaries still exist.
 */
export function isProvisionStampCurrent(
  stamp: ProvisionStamp | undefined,
  vendor: VendorRuntimeLayout,
  userRoot: string,
): boolean {
  if (!stamp) return false;
  const roots = rootsFromRuntimeRoot(userRoot);
  if (!roots) return false;
  const manifest =
    vendor.archives?.manifest ??
    (vendor.expanded ? readManifestFile(vendor.expanded.manifestPath) : undefined);
  const expectedNode = manifest?.node;
  const expectedPython = manifest?.python;
  if (expectedNode && stamp.node !== expectedNode) return false;
  if (expectedPython && stamp.python !== expectedPython) return false;
  const nodeOk = !expectedNode || Boolean(getBundledNodeExecutable(roots.nodeRoot));
  const pyOk = !expectedPython || Boolean(getBundledPythonExecutable(roots.pythonRoot));
  // tools/ arrived after the first alpha installs: re-extract when it is missing.
  const toolsOk = !vendor.archives?.tools || existsSync(join(userRoot, "tools"));
  return nodeOk && pyOk && toolsOk;
}

export function readProvisionStamp(userDataPath: string): ProvisionStamp | undefined {
  try {
    const path = provisionStampPath(userDataPath);
    if (!existsSync(path)) return undefined;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object") return undefined;
    return parsed as ProvisionStamp;
  } catch {
    return undefined;
  }
}

/**
 * Git's GNU `tar` treats `C:\` as a remote host. Prefer Windows bsdtar,
 * which accepts native drive-letter paths.
 */
export function resolveTarBinary(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform !== "win32") return "tar";
  const root = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
  const systemTar = join(root, "System32", "tar.exe");
  if (existsSync(systemTar)) return systemTar;
  return "tar";
}

function runTar(args: string[]): void {
  execFileSync(resolveTarBinary(), args, { stdio: "ignore" });
}

/**
 * Extract tar.gz archives into destRoot (creates destRoot/node, destRoot/python).
 * Uses system `tar` (macOS/Linux/modern Windows).
 */
export function extractRuntimeArchives(
  archives: { node?: string; python?: string; tools?: string },
  destRoot: string,
): void {
  mkdirSync(destRoot, { recursive: true });
  if (archives.node) {
    const nodeDest = join(destRoot, "node");
    rmSync(nodeDest, { recursive: true, force: true });
    runTar(["-xzf", archives.node, "-C", destRoot]);
  }
  if (archives.python) {
    const pyDest = join(destRoot, "python");
    rmSync(pyDest, { recursive: true, force: true });
    runTar(["-xzf", archives.python, "-C", destRoot]);
  }
  if (archives.tools) {
    rmSync(join(destRoot, "tools"), { recursive: true, force: true });
    runTar(["-xzf", archives.tools, "-C", destRoot]);
  }
}

/**
 * Create npm prefix dir + Python venv (best-effort; never throws to caller of bootstrap).
 */
export function ensureIsolationDirs(options: {
  userDataPath: string;
  pythonBinary?: string | undefined;
}): { npmPrefix: string; pythonVenv: string } {
  const npmPrefix = npmPrefixDir(options.userDataPath);
  const pythonVenv = pythonVenvDir(options.userDataPath);
  mkdirSync(join(npmPrefix, "bin"), { recursive: true });
  mkdirSync(join(npmPrefix, "lib"), { recursive: true });

  // venv layout: venv/bin/python3 — same shape as a python install root.
  const venvHasPython =
    existsSync(join(pythonVenv, "bin", "python3")) ||
    existsSync(join(pythonVenv, "bin", "python")) ||
    existsSync(join(pythonVenv, "Scripts", "python.exe")) ||
    existsSync(join(pythonVenv, "Scripts", "python3.exe"));

  const pyBin = options.pythonBinary;
  if (!venvHasPython && pyBin && existsSync(pyBin)) {
    try {
      rmSync(pythonVenv, { recursive: true, force: true });
      execFileSync(pyBin, ["-m", "venv", pythonVenv], {
        stdio: "ignore",
        timeout: 120_000,
      });
    } catch (error) {
      console.warn("[zeno] python venv create failed:", error);
    }
  }

  return { npmPrefix, pythonVenv };
}

function isolationDirsForPythonRoot(
  userDataPath: string,
  skipVenv: boolean | undefined,
  pythonRoot: string,
): { npmPrefix: string; pythonVenv: string } {
  if (skipVenv) {
    return ensureIsolationDirs({ userDataPath });
  }
  const pythonBinary = getBundledPythonExecutable(pythonRoot);
  if (pythonBinary) {
    return ensureIsolationDirs({ userDataPath, pythonBinary });
  }
  return ensureIsolationDirs({ userDataPath });
}

/**
 * Env vars that keep npm/pip installs inside userData isolation trees.
 */
export function buildRuntimeIsolationEnv(layout: ProvisionedRuntimeLayout): Record<string, string> {
  const env: Record<string, string> = {};
  env.NPM_CONFIG_PREFIX = layout.npmPrefix;
  env.npm_config_prefix = layout.npmPrefix;
  // Prefer venv when present
  const venvPy =
    getBundledPythonExecutable(layout.pythonVenv) ||
    (existsSync(join(layout.pythonVenv, "bin", "python3"))
      ? join(layout.pythonVenv, "bin", "python3")
      : existsSync(join(layout.pythonVenv, "Scripts", "python.exe"))
        ? join(layout.pythonVenv, "Scripts", "python.exe")
        : undefined);
  if (venvPy) {
    env.VIRTUAL_ENV = layout.pythonVenv;
    env.PIP_DISABLE_PIP_VERSION_CHECK = "1";
  }
  return env;
}

/** Extra PATH dirs for isolation (npm-prefix bin, venv bin) — before interpreter bins. */
export function isolationBinDirs(layout: ProvisionedRuntimeLayout): string[] {
  const dirs: string[] = [];
  const npmBin = join(layout.npmPrefix, process.platform === "win32" ? "" : "bin");
  const npmBinWin = join(layout.npmPrefix);
  if (process.platform === "win32") {
    if (existsSync(npmBinWin)) dirs.push(npmBinWin);
  } else if (existsSync(npmBin)) {
    dirs.push(npmBin);
  }
  const venvBin =
    process.platform === "win32"
      ? join(layout.pythonVenv, "Scripts")
      : join(layout.pythonVenv, "bin");
  if (existsSync(venvBin)) dirs.push(venvBin);
  return dirs;
}

/**
 * Resolve active runtime roots: prefer provisioned userData; else extract archives;
 * else use expanded vendor (dev).
 */
export function ensureProvisionedRuntimes(options: {
  userDataPath: string;
  resourcesPath?: string;
  mainModuleUrl?: string;
  explicitVendorRoot?: string;
  /** Skip venv creation (tests). */
  skipVenv?: boolean;
}): ProvisionedRuntimeLayout | undefined {
  const vendorOpts: {
    resourcesPath?: string;
    mainModuleUrl?: string;
    explicitVendorRoot?: string;
  } = {};
  if (options.resourcesPath) vendorOpts.resourcesPath = options.resourcesPath;
  if (options.mainModuleUrl) vendorOpts.mainModuleUrl = options.mainModuleUrl;
  if (options.explicitVendorRoot) vendorOpts.explicitVendorRoot = options.explicitVendorRoot;
  const vendor = resolveVendorRuntimeLayout(vendorOpts);
  if (!vendor) return undefined;

  const userRoot = userRuntimesRoot(options.userDataPath);
  const stamp = readProvisionStamp(options.userDataPath);

  // Fast path: already provisioned at matching versions
  if (vendor.archives && isProvisionStampCurrent(stamp, vendor, userRoot)) {
    const roots = rootsFromRuntimeRoot(userRoot);
    if (roots) {
      const iso = isolationDirsForPythonRoot(
        options.userDataPath,
        options.skipVenv,
        roots.pythonRoot,
      );
      return {
        roots,
        npmPrefix: iso.npmPrefix,
        pythonVenv: iso.pythonVenv,
        provisioned: true,
        source: "userData",
      };
    }
  }

  // Packaged: extract archives into userData
  if (vendor.archives && (vendor.archives.node || vendor.archives.python)) {
    try {
      mkdirSync(userRoot, { recursive: true });
      extractRuntimeArchives(
        {
          ...(vendor.archives.node ? { node: vendor.archives.node } : {}),
          ...(vendor.archives.python ? { python: vendor.archives.python } : {}),
          ...(vendor.archives.tools ? { tools: vendor.archives.tools } : {}),
        },
        userRoot,
      );
      // Copy vendor manifest into user tree for status UI
      const manSrc = join(vendor.vendorRoot, "manifest.json");
      if (existsSync(manSrc)) {
        writeFileSync(join(userRoot, "manifest.json"), readFileSync(manSrc));
      } else if (vendor.archives.manifest) {
        writeFileSync(
          join(userRoot, "manifest.json"),
          `${JSON.stringify(vendor.archives.manifest, null, 2)}\n`,
        );
      }

      const roots = rootsFromRuntimeRoot(userRoot);
      if (!roots) {
        console.warn("[zeno] runtime extract finished but binaries missing");
      } else {
        const iso = isolationDirsForPythonRoot(
          options.userDataPath,
          options.skipVenv,
          roots.pythonRoot,
        );
        const nextStamp: ProvisionStamp = {
          provisionedAt: new Date().toISOString(),
          ...(vendor.archives.manifest.node ? { node: vendor.archives.manifest.node } : {}),
          ...(vendor.archives.manifest.python ? { python: vendor.archives.manifest.python } : {}),
          ...(vendor.archives.manifest.pythonReleaseTag
            ? { pythonReleaseTag: vendor.archives.manifest.pythonReleaseTag }
            : {}),
          ...(vendor.archives.manifest.key ? { key: vendor.archives.manifest.key } : {}),
        };
        writeFileSync(
          provisionStampPath(options.userDataPath),
          `${JSON.stringify(nextStamp, null, 2)}\n`,
        );
        console.log("[zeno] provisioned managed runtimes into", userRoot);
        return {
          roots,
          npmPrefix: iso.npmPrefix,
          pythonVenv: iso.pythonVenv,
          provisioned: true,
          source: "userData",
        };
      }
    } catch (error) {
      console.warn("[zeno] runtime archive extract failed:", error);
      // fall through to expanded vendor
    }
  }

  // Dev / fallback: use expanded vendor tree in-place
  if (vendor.expanded) {
    const iso = isolationDirsForPythonRoot(
      options.userDataPath,
      options.skipVenv,
      vendor.expanded.pythonRoot,
    );
    return {
      roots: vendor.expanded,
      npmPrefix: iso.npmPrefix,
      pythonVenv: iso.pythonVenv,
      provisioned: false,
      source: "vendor-expanded",
    };
  }

  return undefined;
}

/** List archive files under a vendor root (for diagnostics/tests). */
export function listVendorArchiveNames(vendorRoot: string): string[] {
  const dir = join(vendorRoot, "archives");
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((n) => n.endsWith(".tar.gz") || n.endsWith(".zip"));
  } catch {
    return [];
  }
}

// ── PRSLOY: window first — decide cheaply at startup, extract in the background ──────

export type ProvisionPlan =
  | { kind: "ready"; layout: ProvisionedRuntimeLayout }
  | { kind: "extract"; vendor: VendorRuntimeLayout; userRoot: string }
  | { kind: "none" };

type ProvisionOptions = Parameters<typeof ensureProvisionedRuntimes>[0];

/**
 * Cheap startup decision (existsSync + small JSON reads only): runtimes already usable
 * (current stamp, or the expanded dev tree) → "ready"; packaged archives that still need
 * unpacking → "extract" (do it with provisionRuntimesAsync after the window is up).
 */
export function planProvisionedRuntimes(options: ProvisionOptions): ProvisionPlan {
  const vendor = resolveVendorRuntimeLayout({
    ...(options.resourcesPath ? { resourcesPath: options.resourcesPath } : {}),
    ...(options.mainModuleUrl ? { mainModuleUrl: options.mainModuleUrl } : {}),
    ...(options.explicitVendorRoot ? { explicitVendorRoot: options.explicitVendorRoot } : {}),
  });
  if (!vendor) return { kind: "none" };
  const userRoot = userRuntimesRoot(options.userDataPath);
  const stamp = readProvisionStamp(options.userDataPath);
  if (vendor.archives && (vendor.archives.node || vendor.archives.python)) {
    if (isProvisionStampCurrent(stamp, vendor, userRoot)) {
      const roots = rootsFromRuntimeRoot(userRoot);
      if (roots) {
        return {
          kind: "ready",
          layout: {
            roots,
            npmPrefix: npmPrefixDir(options.userDataPath),
            pythonVenv: pythonVenvDir(options.userDataPath),
            provisioned: true,
            source: "userData",
          },
        };
      }
    }
    return { kind: "extract", vendor, userRoot };
  }
  if (vendor.expanded) {
    return {
      kind: "ready",
      layout: {
        roots: vendor.expanded,
        npmPrefix: npmPrefixDir(options.userDataPath),
        pythonVenv: pythonVenvDir(options.userDataPath),
        provisioned: false,
        source: "vendor-expanded",
      },
    };
  }
  return { kind: "none" };
}

function runAsync(command: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args[0] ?? ""} exited with ${code}`));
    });
  });
}

function countFilesUnder(root: string): number {
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

/**
 * Unpack the shipped archives without blocking the main process: into a staging dir,
 * then rename node/ python/ tools/ into place and write the stamp last. An interrupted
 * run (app closed, uninstall) leaves the old tree or nothing — never a half tree with a
 * current stamp. `onProgress(done, total)` counts unpacked files (total from manifest).
 */
export async function provisionRuntimesAsync(
  options: ProvisionOptions & {
    plan: Extract<ProvisionPlan, { kind: "extract" }>;
    onProgress?: (done: number, total: number | undefined) => void;
    pollMs?: number;
  },
): Promise<ProvisionedRuntimeLayout | undefined> {
  const { vendor, userRoot } = options.plan;
  const archives = vendor.archives;
  if (!archives) return undefined;
  const manifest = archives.manifest as BundledRuntimeManifest & {
    nodeFiles?: number;
    pythonFiles?: number;
  };
  const total =
    manifest.nodeFiles && manifest.pythonFiles
      ? manifest.nodeFiles + manifest.pythonFiles
      : undefined;
  // A stale stamp must never vouch for a tree that is being replaced.
  rmSync(provisionStampPath(options.userDataPath), { force: true });
  const staging = join(userRoot, `.staging-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const timer = setInterval(
    () => options.onProgress?.(countFilesUnder(staging), total),
    options.pollMs ?? 1000,
  );
  try {
    for (const archive of [archives.node, archives.python, archives.tools]) {
      if (archive) await runAsync(resolveTarBinary(), ["-xzf", archive, "-C", staging], 600_000);
    }
    for (const name of ["node", "python", "tools"]) {
      const from = join(staging, name);
      if (!existsSync(from)) continue;
      rmSync(join(userRoot, name), { recursive: true, force: true });
      renameSync(from, join(userRoot, name));
    }
  } finally {
    clearInterval(timer);
    rmSync(staging, { recursive: true, force: true });
  }
  options.onProgress?.(total ?? 1, total ?? 1);

  const manSrc = join(vendor.vendorRoot, "manifest.json");
  if (existsSync(manSrc)) writeFileSync(join(userRoot, "manifest.json"), readFileSync(manSrc));
  const roots = rootsFromRuntimeRoot(userRoot);
  if (!roots) return undefined;

  const npmPrefix = npmPrefixDir(options.userDataPath);
  const pythonVenv = pythonVenvDir(options.userDataPath);
  mkdirSync(join(npmPrefix, "bin"), { recursive: true });
  mkdirSync(join(npmPrefix, "lib"), { recursive: true });
  const pyBin = getBundledPythonExecutable(roots.pythonRoot);
  if (!options.skipVenv && pyBin) {
    try {
      rmSync(pythonVenv, { recursive: true, force: true });
      await runAsync(pyBin, ["-m", "venv", pythonVenv], 180_000);
    } catch (error) {
      console.warn("[zeno] python venv create failed:", error);
    }
  }
  const stamp: ProvisionStamp = {
    provisionedAt: new Date().toISOString(),
    ...(manifest.node ? { node: manifest.node } : {}),
    ...(manifest.python ? { python: manifest.python } : {}),
    ...(manifest.pythonReleaseTag ? { pythonReleaseTag: manifest.pythonReleaseTag } : {}),
    ...(manifest.key ? { key: manifest.key } : {}),
  };
  writeFileSync(provisionStampPath(options.userDataPath), `${JSON.stringify(stamp, null, 2)}\n`);
  return { roots, npmPrefix, pythonVenv, provisioned: true, source: "userData" };
}
