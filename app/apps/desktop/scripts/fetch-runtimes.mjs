/**
 * Download platform-matched Node.js + Python into apps/desktop/runtimes/
 * and materialize runtimes/current/ for electron-builder extraResources.
 *
 * Usage:
 *   node scripts/fetch-runtimes.mjs
 *   node scripts/fetch-runtimes.mjs --platform darwin --arch arm64
 *   node scripts/fetch-runtimes.mjs --force
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  linkSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = resolve(__dirname, "..");
const RUNTIMES_ROOT = join(DESKTOP_ROOT, "runtimes");
const VERSIONS_PATH = join(RUNTIMES_ROOT, "versions.json");
const CACHE_ROOT = join(homedir(), ".cache", "zeno-runtimes");

/**
 * Windows also pins Git for Windows (PortableGit: bash for pi's bash tool + git for
 * per-turn snapshots) and ripgrep/fd (pi's grep/find tools would otherwise download
 * them from GitHub at first use).
 *
 * @typedef {{
 *   node: string,
 *   python: string,
 *   pythonReleaseTag: string,
 *   git?: string,
 *   gitTag?: string,
 *   gitSha256?: string,
 *   ripgrep?: string,
 *   fd?: string,
 * }} RuntimeVersions
 */

function parseArgs(argv) {
  /** @type {{ platform?: string, arch?: string, force: boolean }} */
  const out = { force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--force") out.force = true;
    else if (a === "--platform") out.platform = argv[++i];
    else if (a === "--arch") out.arch = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log(`Usage: node fetch-runtimes.mjs [--platform <os>] [--arch <arch>] [--force]`);
      process.exit(0);
    }
  }
  return out;
}

/**
 * @param {string} [versionsPath]
 * @returns {RuntimeVersions}
 */
export function loadVersions(versionsPath = VERSIONS_PATH) {
  const raw = JSON.parse(readFileSync(versionsPath, "utf8"));
  if (!raw?.node || !raw?.python || !raw?.pythonReleaseTag) {
    throw new Error(`Invalid ${versionsPath}: need node, python, pythonReleaseTag`);
  }
  return {
    node: String(raw.node),
    python: String(raw.python),
    pythonReleaseTag: String(raw.pythonReleaseTag),
    ...(raw.git ? { git: String(raw.git) } : {}),
    ...(raw.gitTag ? { gitTag: String(raw.gitTag) } : {}),
    ...(raw.gitSha256 ? { gitSha256: String(raw.gitSha256).toLowerCase() } : {}),
    ...(raw.ripgrep ? { ripgrep: String(raw.ripgrep) } : {}),
    ...(raw.fd ? { fd: String(raw.fd) } : {}),
  };
}

/**
 * PortableGit (Windows only). A 7-Zip self-extractor; ~60MB download.
 * @param {{ os: string, arch: string }} target
 * @param {RuntimeVersions} versions
 */
export function gitDistMeta(target, versions) {
  if (target.os !== "win32" || !versions.git) return undefined;
  const tag = versions.gitTag || `v${versions.git}.windows.1`;
  const name = `PortableGit-${versions.git}-64-bit.7z.exe`;
  return {
    url: `https://github.com/git-for-windows/git/releases/download/${tag}/${name}`,
    archiveName: name,
    kind: "7z.exe",
    ...(versions.gitSha256 ? { sha256: versions.gitSha256 } : {}),
  };
}

/**
 * ripgrep + fd for pi's grep/find tools (Windows only).
 * @param {{ os: string, arch: string }} target
 * @param {RuntimeVersions} versions
 */
export function searchToolsDistMeta(target, versions) {
  if (target.os !== "win32") return [];
  const out = [];
  if (versions.ripgrep) {
    const name = `ripgrep-${versions.ripgrep}-x86_64-pc-windows-msvc.zip`;
    out.push({
      tool: "rg",
      binary: "rg.exe",
      archiveName: name,
      url: `https://github.com/BurntSushi/ripgrep/releases/download/${versions.ripgrep}/${name}`,
    });
  }
  if (versions.fd) {
    const name = `fd-v${versions.fd}-x86_64-pc-windows-msvc.zip`;
    out.push({
      tool: "fd",
      binary: "fd.exe",
      archiveName: name,
      url: `https://github.com/sharkdp/fd/releases/download/v${versions.fd}/${name}`,
    });
  }
  return out;
}

/**
 * Replace byte-identical files with hard links (git's builtins under libexec/git-core are
 * ~100 copies of the same binaries once the 7z SFX materializes them). tar then stores
 * each link once and recreates it on extract, which shrinks git.tar.gz a lot.
 * @param {string} root
 * @param {number} [minBytes]
 * @returns {number} bytes saved
 */
export function dedupeIdenticalFiles(root, minBytes = 64 * 1024) {
  if (!root || !existsSync(root)) return 0;
  /** @type {Map<number, string[]>} */
  const bySize = new Map();
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    if (!dir) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        const { size } = statSync(full);
        if (size < minBytes) continue;
        const list = bySize.get(size) ?? [];
        list.push(full);
        bySize.set(size, list);
      }
    }
  }
  let saved = 0;
  for (const [size, paths] of bySize) {
    if (paths.length < 2) continue;
    /** @type {Map<string, string>} */
    const firstByHash = new Map();
    for (const path of paths) {
      const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
      const first = firstByHash.get(hash);
      if (!first) {
        firstByHash.set(hash, path);
        continue;
      }
      if (statSync(first).ino === statSync(path).ino && statSync(path).ino !== 0) continue;
      const tmp = `${path}.dedupe-tmp`;
      try {
        linkSync(first, tmp);
        rmSync(path, { force: true });
        renameSync(tmp, path);
        saved += size;
      } catch {
        rmSync(tmp, { force: true });
      }
    }
  }
  return saved;
}

/**
 * Drop docs, translations and the Tcl/Tk GUIs (gitk, git-gui) from PortableGit.
 * Keeps bash, coreutils, perl, ssh, curl and git itself intact.
 * @param {string} gitRoot
 * @returns {number} approximate bytes removed
 */
export function pruneGitRuntime(gitRoot) {
  if (!gitRoot || !existsSync(gitRoot)) return 0;
  const drop = [
    join(gitRoot, "mingw64", "share", "doc"),
    join(gitRoot, "mingw64", "share", "locale"),
    join(gitRoot, "mingw64", "share", "gitk"),
    join(gitRoot, "mingw64", "share", "git-gui"),
    join(gitRoot, "mingw64", "share", "man"),
    join(gitRoot, "usr", "share", "doc"),
    join(gitRoot, "usr", "share", "man"),
    join(gitRoot, "usr", "share", "info"),
    join(gitRoot, "usr", "share", "locale"),
    // An agent must never land in an interactive editor; git-lfs is unused (~10MB).
    join(gitRoot, "usr", "share", "vim"),
    join(gitRoot, "usr", "bin", "vim.exe"),
    join(gitRoot, "usr", "bin", "vimdiff"),
    join(gitRoot, "usr", "bin", "vi"),
    join(gitRoot, "usr", "bin", "view"),
    join(gitRoot, "mingw64", "bin", "git-lfs.exe"),
    join(gitRoot, "mingw64", "bin", "gitk"),
    join(gitRoot, "cmd", "gitk.exe"),
    join(gitRoot, "cmd", "git-gui.exe"),
    join(gitRoot, "git-bash.exe"),
    join(gitRoot, "git-cmd.exe"),
    join(gitRoot, "README.portable"),
  ];
  for (const libDir of [join(gitRoot, "mingw64", "lib")]) {
    if (!existsSync(libDir)) continue;
    for (const name of readdirSync(libDir)) {
      if (/^(tcl|tk|itcl|tdbc|thread)\d/i.test(name)) drop.push(join(libDir, name));
    }
  }
  const gitCore = join(gitRoot, "mingw64", "libexec", "git-core");
  if (existsSync(gitCore)) {
    for (const name of readdirSync(gitCore)) {
      if (name.startsWith("git-gui")) drop.push(join(gitCore, name));
    }
  }
  let removed = 0;
  for (const path of drop) removed += removePathBestEffort(path);
  return removed;
}

/**
 * Map host / electron-builder arch names to our cache key pieces.
 * @param {string | undefined} platform
 * @param {string | undefined} arch
 */
export function resolveTarget(platform, arch) {
  const plat = (platform || process.platform).toLowerCase();
  let a = (arch || process.arch).toLowerCase();
  if (a === "x86_64") a = "x64";
  if (a === "aarch64") a = "arm64";

  /** @type {"darwin" | "win32" | "linux"} */
  let os;
  if (plat === "darwin" || plat === "mac" || plat === "macos") os = "darwin";
  else if (plat === "win32" || plat === "win" || plat === "windows") os = "win32";
  else if (plat === "linux") os = "linux";
  else throw new Error(`Unsupported platform: ${plat}`);

  if (a !== "x64" && a !== "arm64") {
    throw new Error(`Unsupported arch: ${a} (need x64 or arm64)`);
  }
  // Official Node windows arm64 exists but our release matrix is win-x64 only for now.
  if (os === "win32" && a === "arm64") {
    console.warn("[fetch-runtimes] win arm64 requested; using win x64 Node/Python assets");
    a = "x64";
  }
  return { os, arch: a, key: `${os}-${a}` };
}

/**
 * @param {{ os: string, arch: string }} target
 * @param {RuntimeVersions} versions
 */
export function nodeDistMeta(target, versions) {
  const v = versions.node;
  if (target.os === "darwin") {
    const narch = target.arch === "arm64" ? "arm64" : "x64";
    const name = `node-v${v}-darwin-${narch}.tar.gz`;
    return {
      url: `https://nodejs.org/dist/v${v}/${name}`,
      archiveName: name,
      kind: "tar.gz",
      stripTop: true,
    };
  }
  if (target.os === "linux") {
    const narch = target.arch === "arm64" ? "arm64" : "x64";
    const name = `node-v${v}-linux-${narch}.tar.gz`;
    return {
      url: `https://nodejs.org/dist/v${v}/${name}`,
      archiveName: name,
      kind: "tar.gz",
      stripTop: true,
    };
  }
  // win32
  const name = `node-v${v}-win-x64.zip`;
  return {
    url: `https://nodejs.org/dist/v${v}/${name}`,
    archiveName: name,
    kind: "zip",
    stripTop: true,
  };
}

/**
 * @param {{ os: string, arch: string }} target
 * @param {RuntimeVersions} versions
 */
export function pythonDistMeta(target, versions) {
  const tag = versions.pythonReleaseTag;
  const py = versions.python;
  /** @type {string} */
  let triple;
  if (target.os === "darwin") {
    triple = target.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  } else if (target.os === "linux") {
    triple = target.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
  } else {
    triple = "x86_64-pc-windows-msvc";
  }
  // install_only_stripped drops debug symbols / tests — much smaller than install_only.
  const name = `cpython-${py}+${tag}-${triple}-install_only_stripped.tar.gz`;
  return {
    url: `https://github.com/astral-sh/python-build-standalone/releases/download/${tag}/${name}`,
    archiveName: name,
    kind: "tar.gz",
    stripTop: false,
  };
}

/**
 * @param {string} url
 * @param {string} destFile
 */
async function download(url, destFile) {
  mkdirSync(dirname(destFile), { recursive: true });
  if (existsSync(destFile) && statSync(destFile).size > 0) {
    console.log(`[fetch-runtimes] cache hit ${destFile}`);
    return;
  }
  console.log(`[fetch-runtimes] download ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed ${res.status} ${url}`);
  }
  const tmp = `${destFile}.partial`;
  await pipeline(res.body, createWriteStream(tmp));
  // renameSync may fail across devices; copy+unlink is fine for cache.
  copyFileSync(tmp, destFile);
  rmSync(tmp, { force: true });
}

/**
 * Git's GNU `tar` treats `C:\` as a remote host ("Cannot connect to C:").
 * Windows built-in bsdtar (`%SystemRoot%\System32\tar.exe`) accepts drive letters.
 * Prefer that binary so pack/extract work without rewriting paths to `/c/...`
 * (which System32 tar does not understand).
 *
 * @param {string} [platform]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveTarBinary(platform = process.platform, env = process.env) {
  if (platform !== "win32") return "tar";
  const root = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
  const systemTar = join(root, "System32", "tar.exe");
  if (existsSync(systemTar)) return systemTar;
  return "tar";
}

/**
 * @param {string[]} args tar argv after the binary name
 * @param {{ stdio?: "inherit" | "ignore" }} [opts]
 */
export function runTar(args, opts = {}) {
  const stdio = opts.stdio ?? "inherit";
  execFileSync(resolveTarBinary(), args, { stdio });
}

/**
 * @param {string} archive
 * @param {string} destDir
 * @param {"tar.gz" | "zip"} kind
 */
function extractArchive(archive, destDir, kind) {
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  if (kind === "tar.gz") {
    // System tar is available on macOS, Linux, and modern Windows.
    runTar(["-xzf", archive, "-C", destDir], { stdio: "inherit" });
    return;
  }
  if (process.platform === "win32") {
    const litArchive = archive.replace(/'/g, "''");
    const litDest = destDir.replace(/'/g, "''");
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Expand-Archive -LiteralPath '${litArchive}' -DestinationPath '${litDest}' -Force`,
      ],
      { stdio: "inherit" },
    );
    return;
  }
  // unzip fallback
  execFileSync("unzip", ["-q", archive, "-d", destDir], { stdio: "inherit" });
}

/**
 * Unpack a 7-Zip self-extractor (PortableGit). Prefer a real 7z (preinstalled on GitHub
 * windows runners), else let the SFX unpack itself with its `-y -o<dir>` switches.
 * @param {string} archive
 * @param {string} destDir
 */
function extractSevenZipSfx(archive, destDir) {
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  const candidates = [process.env.SEVEN_ZIP, "7z", "C:\\Program Files\\7-Zip\\7z.exe"].filter(
    Boolean,
  );
  for (const bin of candidates) {
    try {
      execFileSync(bin, ["x", archive, `-o${destDir}`, "-y", "-bso0", "-bsp0"], {
        stdio: "inherit",
      });
      return;
    } catch {
      // try the next extractor
    }
  }
  if (process.platform !== "win32") {
    throw new Error("7z is required to unpack PortableGit on a non-Windows host");
  }
  execFileSync(archive, ["-y", `-o${destDir}`], { stdio: "inherit" });
}

/**
 * @param {string} root
 * @param {string} fileName
 * @returns {string | undefined}
 */
function findFileRecursive(root, fileName) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    if (!dir) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.toLowerCase() === fileName.toLowerCase()) return full;
    }
  }
  return undefined;
}

/**
 * If archive extracted a single top-level dir, return its path; else destDir.
 * @param {string} destDir
 */
function unwrapSingleTopDir(destDir) {
  const entries = readdirSync(destDir, { withFileTypes: true }).filter(
    (e) => !e.name.startsWith("."),
  );
  if (entries.length === 1 && entries[0]?.isDirectory()) {
    return join(destDir, entries[0].name);
  }
  return destDir;
}

/**
 * Copy directory tree (files only; follow symlinks as files when possible).
 * @param {string} src
 * @param {string} dest
 */
function copyTree(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) {
      copyTree(from, to);
    } else if (entry.isSymbolicLink()) {
      // Materialize symlink targets as copies when possible.
      try {
        copyFileSync(from, to);
      } catch {
        // skip broken links
      }
    } else {
      copyFileSync(from, to);
    }
  }
}

/**
 * Ensure unix execute bits on common bin names.
 * @param {string} root
 */
function ensureUnixExecuteBits(root) {
  if (process.platform === "win32") return;
  const candidates = [
    join(root, "bin", "node"),
    join(root, "bin", "npm"),
    join(root, "bin", "npx"),
    join(root, "bin", "python"),
    join(root, "bin", "python3"),
    join(root, "node"),
    join(root, "node.exe"),
    join(root, "python.exe"),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const mode = statSync(p).mode;
      chmodSync(p, mode | 0o755);
    } catch {
      // ignore
    }
  }
}

/**
 * @param {string} nodeRoot
 */
function findNodeBinary(nodeRoot) {
  const candidates =
    process.platform === "win32" || existsSync(join(nodeRoot, "node.exe"))
      ? [join(nodeRoot, "node.exe"), join(nodeRoot, "bin", "node.exe")]
      : [join(nodeRoot, "bin", "node"), join(nodeRoot, "node")];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return undefined;
}

/**
 * @param {string} pythonRoot
 */
function findPythonBinary(pythonRoot) {
  const candidates = [
    join(pythonRoot, "bin", "python3"),
    join(pythonRoot, "bin", "python"),
    join(pythonRoot, "python.exe"),
    join(pythonRoot, "bin", "python.exe"),
    join(pythonRoot, "python", "python.exe"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // install_only often has python/ top folder
  const nested = join(pythonRoot, "python");
  if (existsSync(nested)) {
    for (const c of [
      join(nested, "bin", "python3"),
      join(nested, "bin", "python"),
      join(nested, "python.exe"),
    ]) {
      if (existsSync(c)) return c;
    }
  }
  return undefined;
}

/**
 * Normalize python tree so bin/python3 lives under destRoot.
 * install_only extracts to `python/` subfolder.
 * @param {string} extracted
 * @param {string} destRoot
 */
function materializePython(extracted, destRoot) {
  rmSync(destRoot, { recursive: true, force: true });
  const nested = join(extracted, "python");
  const src = existsSync(nested) ? nested : extracted;
  copyTree(src, destRoot);
  ensureUnixExecuteBits(destRoot);
  // Convenience: ensure python3 name exists on unix
  const py3 = join(destRoot, "bin", "python3");
  const py = join(destRoot, "bin", "python");
  if (!existsSync(py3) && existsSync(py) && process.platform !== "win32") {
    try {
      copyFileSync(py, py3);
      chmodSync(py3, 0o755);
    } catch {
      // ignore
    }
  }
  prunePythonRuntime(destRoot);
}

/**
 * @param {string} extracted
 * @param {string} destRoot
 */
function materializeNode(extracted, destRoot) {
  rmSync(destRoot, { recursive: true, force: true });
  copyTree(extracted, destRoot);
  ensureUnixExecuteBits(destRoot);
  pruneNodeRuntime(destRoot);
}

/**
 * Drop headers/docs we never compile against — keeps bin/node + npm only.
 * Official Node tarball ships ~50–60MB of include/ that is useless at runtime.
 * @param {string} nodeRoot
 * @returns {number} approximate bytes removed (best-effort)
 */
export function pruneNodeRuntime(nodeRoot) {
  if (!nodeRoot || !existsSync(nodeRoot)) return 0;
  let removed = 0;
  const drop = [
    join(nodeRoot, "include"),
    join(nodeRoot, "share"),
    join(nodeRoot, "CHANGELOG.md"),
    join(nodeRoot, "README.md"),
    join(nodeRoot, "LICENSE"),
  ];
  for (const p of drop) {
    removed += removePathBestEffort(p);
  }
  // Do not `strip` the node binary — Apple Silicon Node builds often break after strip.
  return removed;
}

/**
 * Drop Tcl/Tk, idle, headers, tests — keep a usable stdlib for agent scripts.
 * @param {string} pythonRoot
 * @returns {number}
 */
export function prunePythonRuntime(pythonRoot) {
  if (!pythonRoot || !existsSync(pythonRoot)) return 0;
  let removed = 0;
  const drop = [
    join(pythonRoot, "include"),
    join(pythonRoot, "share"),
    join(pythonRoot, "lib", "pkgconfig"),
  ];
  // Tcl/Tk and friends are huge and unused by typical agent tooling.
  const libDir = join(pythonRoot, "lib");
  if (existsSync(libDir)) {
    for (const name of readdirSync(libDir)) {
      if (
        name.startsWith("tcl") ||
        name.startsWith("tk") ||
        name.startsWith("itcl") ||
        name.startsWith("thread") ||
        name.startsWith("tdbc") ||
        name.startsWith("sqlite") ||
        /^lib(tcl|tk)/i.test(name)
      ) {
        drop.push(join(libDir, name));
      }
    }
  }
  // Find lib/pythonX.Y
  let pyLib;
  if (existsSync(libDir)) {
    for (const name of readdirSync(libDir)) {
      if (/^python\d+\.\d+$/.test(name)) {
        pyLib = join(libDir, name);
        break;
      }
    }
  }
  if (pyLib) {
    for (const name of [
      "idlelib",
      "tkinter",
      "turtledemo",
      "turtle.py",
      "pydoc_data",
      "lib2to3",
      "test",
      "tests",
      "ensurepip/_bundled", // keep ensurepip module; drop heavy wheels if present as dir
    ]) {
      drop.push(join(pyLib, name));
    }
    // config-* build dirs
    try {
      for (const name of readdirSync(pyLib)) {
        if (name.startsWith("config-")) drop.push(join(pyLib, name));
      }
    } catch {
      // ignore
    }
  }
  // CLI helpers we do not need on PATH for the agent
  const binDir = join(pythonRoot, "bin");
  if (existsSync(binDir)) {
    try {
      for (const name of readdirSync(binDir)) {
        if (
          name.startsWith("2to3") ||
          name.startsWith("idle") ||
          name.startsWith("pydoc") ||
          name.startsWith("python3-config") ||
          name.endsWith("-config")
        ) {
          drop.push(join(binDir, name));
        }
      }
    } catch {
      // ignore
    }
  }
  for (const p of drop) {
    removed += removePathBestEffort(p);
  }
  // __pycache__ / *.pyc
  removed += removePycaches(pythonRoot);
  return removed;
}

/**
 * @param {string} path
 * @returns {number}
 */
function removePathBestEffort(path) {
  if (!path || !existsSync(path)) return 0;
  let size = 0;
  try {
    size = dirSizeBytes(path);
  } catch {
    size = 0;
  }
  try {
    rmSync(path, { recursive: true, force: true });
    return size;
  } catch {
    return 0;
  }
}

/**
 * @param {string} root
 * @returns {number}
 */
function removePycaches(root) {
  let removed = 0;
  /** @type {string[]} */
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__pycache__") {
          removed += removePathBestEffort(full);
        } else {
          stack.push(full);
        }
      } else if (entry.name.endsWith(".pyc") || entry.name.endsWith(".pyo")) {
        removed += removePathBestEffort(full);
      }
    }
  }
  return removed;
}

/**
 * @param {string} path
 * @returns {number}
 */
function dirSizeBytes(path) {
  let total = 0;
  const st = lstatSync(path);
  if (st.isFile() || st.isSymbolicLink()) return st.size;
  if (!st.isDirectory()) return 0;
  for (const name of readdirSync(path)) {
    total += dirSizeBytes(join(path, name));
  }
  return total;
}

/**
 * @param {string} file
 */
function sha256File(file) {
  const h = createHash("sha256");
  h.update(readFileSync(file));
  return h.digest("hex");
}

/**
 * @param {{ os: string, arch: string, key: string }} target
 * @param {RuntimeVersions} versions
 * @param {boolean} force
 */
async function fetchOne(target, versions, force) {
  const platformDir = join(RUNTIMES_ROOT, target.key);
  const nodeDest = join(platformDir, "node");
  const pythonDest = join(platformDir, "python");
  const manifestPath = join(platformDir, "manifest.json");
  const gitDest = join(platformDir, "git");
  const toolsDest = join(platformDir, "tools");
  const gitMeta = gitDistMeta(target, versions);
  const toolMetas = searchToolsDistMeta(target, versions);

  if (
    !force &&
    existsSync(manifestPath) &&
    findNodeBinary(nodeDest) &&
    findPythonBinary(pythonDest) &&
    (!gitMeta || existsSync(join(gitDest, "bin", "bash.exe"))) &&
    toolMetas.every((t) => existsSync(join(toolsDest, t.binary)))
  ) {
    try {
      const prev = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (
        prev.node === versions.node &&
        prev.python === versions.python &&
        (prev.git ?? undefined) === (gitMeta ? versions.git : undefined) &&
        prev.pruned === true
      ) {
        console.log(`[fetch-runtimes] ${target.key} already at pinned versions (pruned)`);
        return { platformDir, nodeDest, pythonDest, manifestPath };
      }
    } catch {
      // re-fetch
    }
  }

  mkdirSync(CACHE_ROOT, { recursive: true });
  mkdirSync(platformDir, { recursive: true });

  // ── Node ──────────────────────────────────────────────────────────────
  const nodeMeta = nodeDistMeta(target, versions);
  const nodeArchive = join(CACHE_ROOT, nodeMeta.archiveName);
  await download(nodeMeta.url, nodeArchive);
  const nodeExtract = join(tmpdir(), `zeno-node-${target.key}-${Date.now()}`);
  try {
    extractArchive(nodeArchive, nodeExtract, nodeMeta.kind);
    const unwrapped = nodeMeta.stripTop ? unwrapSingleTopDir(nodeExtract) : nodeExtract;
    materializeNode(unwrapped, nodeDest);
  } finally {
    rmSync(nodeExtract, { recursive: true, force: true });
  }
  const nodeBin = findNodeBinary(nodeDest);
  if (!nodeBin) throw new Error(`Node binary missing after extract (${nodeDest})`);

  // ── Python ────────────────────────────────────────────────────────────
  const pyMeta = pythonDistMeta(target, versions);
  const pyArchive = join(CACHE_ROOT, pyMeta.archiveName);
  await download(pyMeta.url, pyArchive);
  const pyExtract = join(tmpdir(), `zeno-py-${target.key}-${Date.now()}`);
  try {
    extractArchive(pyArchive, pyExtract, pyMeta.kind);
    materializePython(pyExtract, pythonDest);
  } finally {
    rmSync(pyExtract, { recursive: true, force: true });
  }
  // ── Git for Windows (bash for pi's bash tool, git for turn snapshots) ─────
  rmSync(gitDest, { recursive: true, force: true });
  rmSync(join(platformDir, "git.7z.exe"), { force: true });
  let gitFiles = 0;
  if (gitMeta) {
    const gitArchive = join(CACHE_ROOT, gitMeta.archiveName);
    await download(gitMeta.url, gitArchive);
    if (gitMeta.sha256) {
      const actual = sha256File(gitArchive);
      if (actual !== gitMeta.sha256) {
        rmSync(gitArchive, { force: true });
        throw new Error(`PortableGit sha256 mismatch: ${actual} != ${gitMeta.sha256}`);
      }
    }
    extractSevenZipSfx(gitArchive, gitDest);
    // Ship the original self-extractor (LZMA, ~60MB): far smaller than any tar.gz of the
    // tree. First launch unpacks it in the background (runtime-git.ts).
    copyFileSync(gitArchive, join(platformDir, "git.7z.exe"));
    gitFiles = countFiles(gitDest);
    const before = dirSizeBytes(gitDest);
    pruneGitRuntime(gitDest);
    const deduped = dedupeIdenticalFiles(gitDest);
    console.log(
      `[fetch-runtimes] git ${versions.git} sha256=${sha256File(gitArchive)} extracted=${formatMb(before)} pruned=${formatMb(dirSizeBytes(gitDest))} hardlinked=${formatMb(deduped)}`,
    );
    if (!existsSync(join(gitDest, "bin", "bash.exe"))) {
      throw new Error(`PortableGit bash.exe missing after extract (${gitDest})`);
    }
  }

  // ── ripgrep / fd for pi grep/find (no GitHub download at tool time) ──────
  rmSync(toolsDest, { recursive: true, force: true });
  for (const tool of toolMetas) {
    mkdirSync(toolsDest, { recursive: true });
    const archive = join(CACHE_ROOT, tool.archiveName);
    await download(tool.url, archive);
    const extractDir = join(tmpdir(), `zeno-${tool.tool}-${Date.now()}`);
    try {
      extractArchive(archive, extractDir, "zip");
      const found = findFileRecursive(extractDir, tool.binary);
      if (!found) throw new Error(`${tool.binary} missing in ${tool.archiveName}`);
      copyFileSync(found, join(toolsDest, tool.binary));
    } finally {
      rmSync(extractDir, { recursive: true, force: true });
    }
  }

  // Prune again in case materialize skipped (upgrade path).
  pruneNodeRuntime(nodeDest);
  prunePythonRuntime(pythonDest);

  const nodeBinAfter = findNodeBinary(nodeDest);
  const pyBin = findPythonBinary(pythonDest);
  if (!nodeBinAfter) throw new Error(`Node binary missing after prune (${nodeDest})`);
  if (!pyBin) throw new Error(`Python binary missing after extract (${pythonDest})`);

  // Smoke
  try {
    const nodeV = execFileSync(nodeBinAfter, ["-v"], { encoding: "utf8" }).trim();
    console.log(`[fetch-runtimes] node smoke ${nodeV}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Bundled node failed smoke test: ${detail}`);
  }
  try {
    const pyV = execFileSync(pyBin, ["--version"], { encoding: "utf8" }).trim();
    console.log(`[fetch-runtimes] python smoke ${pyV}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Bundled python failed smoke test: ${detail}`);
  }

  if (gitMeta && process.platform === "win32") {
    try {
      const out = execFileSync(
        join(gitDest, "bin", "bash.exe"),
        ["-c", "echo bash-ok; git --version; uname -s"],
        { encoding: "utf8" },
      ).trim();
      console.log(`[fetch-runtimes] git bash smoke: ${out.replace(/\s+/g, " ")}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Bundled Git Bash failed smoke test: ${detail}`);
    }
  }

  const nodeBytes = dirSizeBytes(nodeDest);
  const pyBytes = dirSizeBytes(pythonDest);
  const gitBytes = existsSync(gitDest) ? dirSizeBytes(gitDest) : 0;
  const toolsBytes = existsSync(toolsDest) ? dirSizeBytes(toolsDest) : 0;
  console.log(
    `[fetch-runtimes] sizes node=${formatMb(nodeBytes)} python=${formatMb(pyBytes)} git=${formatMb(gitBytes)} tools=${formatMb(toolsBytes)} total=${formatMb(nodeBytes + pyBytes + gitBytes + toolsBytes)}`,
  );

  const manifest = {
    node: versions.node,
    python: versions.python,
    pythonReleaseTag: versions.pythonReleaseTag,
    platform: target.os,
    arch: target.arch,
    key: target.key,
    pruned: true,
    nodeBytes,
    pythonBytes: pyBytes,
    ...(gitMeta ? { git: versions.git, gitBytes, gitFiles } : {}),
    ...(toolMetas.length
      ? {
          tools: Object.fromEntries(
            toolMetas.map((t) => [t.tool, versions[t.tool === "rg" ? "ripgrep" : "fd"]]),
          ),
          toolsBytes,
        }
      : {}),
    nodeBinary: nodeBinAfter.replace(platformDir + (process.platform === "win32" ? "\\" : "/"), ""),
    pythonBinary: pyBin.replace(platformDir + (process.platform === "win32" ? "\\" : "/"), ""),
    fetchedAt: new Date().toISOString(),
    nodeArchiveSha256: sha256File(nodeArchive),
    pythonArchiveSha256: sha256File(pyArchive),
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`[fetch-runtimes] wrote ${manifestPath}`);
  return { platformDir, nodeDest, pythonDest, manifestPath };
}

/**
 * @param {number} bytes
 */
function formatMb(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Pack pruned trees into archives for shipping (WorkBuddy-style).
 * Archives extract to `node/` and `python/` under the destination root.
 * @param {string} platformDir
 */
export function packShippingArchives(platformDir) {
  const archives = join(platformDir, "archives");
  rmSync(archives, { recursive: true, force: true });
  mkdirSync(archives, { recursive: true });
  const nodeArchive = join(archives, "node.tar.gz");
  const pythonArchive = join(archives, "python.tar.gz");
  const gitArchive = join(archives, "git.7z.exe");
  const toolsArchive = join(archives, "tools.tar.gz");
  if (existsSync(join(platformDir, "node"))) {
    runTar(["-czf", nodeArchive, "-C", platformDir, "node"], { stdio: "ignore" });
    console.log(`[fetch-runtimes] packed ${nodeArchive} (${formatMb(statSync(nodeArchive).size)})`);
  }
  if (existsSync(join(platformDir, "python"))) {
    runTar(["-czf", pythonArchive, "-C", platformDir, "python"], { stdio: "ignore" });
    console.log(
      `[fetch-runtimes] packed ${pythonArchive} (${formatMb(statSync(pythonArchive).size)})`,
    );
  }
  if (existsSync(join(platformDir, "git.7z.exe"))) {
    copyFileSync(join(platformDir, "git.7z.exe"), gitArchive);
    console.log(`[fetch-runtimes] shipped ${gitArchive} (${formatMb(statSync(gitArchive).size)})`);
  }
  if (existsSync(join(platformDir, "tools"))) {
    runTar(["-czf", toolsArchive, "-C", platformDir, "tools"], { stdio: "ignore" });
    console.log(
      `[fetch-runtimes] packed ${toolsArchive} (${formatMb(statSync(toolsArchive).size)})`,
    );
  }
  // Enrich manifest for the provisioner
  const manifestPath = join(platformDir, "manifest.json");
  try {
    const man = JSON.parse(readFileSync(manifestPath, "utf8"));
    man.archives = {
      node: existsSync(nodeArchive) ? "archives/node.tar.gz" : undefined,
      python: existsSync(pythonArchive) ? "archives/python.tar.gz" : undefined,
      git: existsSync(gitArchive) ? "archives/git.7z.exe" : undefined,
      tools: existsSync(toolsArchive) ? "archives/tools.tar.gz" : undefined,
    };
    writeFileSync(manifestPath, `${JSON.stringify(man, null, 2)}\n`, "utf8");
  } catch {
    // ignore
  }
}

/**
 * Point runtimes/current at the platform dir for electron-builder + local dev.
 * Prefer a directory symlink so we do not store two full copies (~2× disk).
 * Archives live under the platform dir (and thus under current via the link).
 * @param {string} platformDir
 */
function materializeCurrent(platformDir) {
  packShippingArchives(platformDir);

  const current = join(RUNTIMES_ROOT, "current");
  try {
    rmSync(current, { recursive: true, force: true });
  } catch {
    // ignore
  }
  try {
    // Relative link so the tree is relocatable within apps/desktop/runtimes/.
    const rel = platformDir.startsWith(RUNTIMES_ROOT)
      ? platformDir.slice(RUNTIMES_ROOT.length).replace(/^[/\\]/, "")
      : platformDir;
    // Junctions on Windows look like real directories to electron-builder
    // extraResources; `dir` symlinks are often copied as empty link files.
    const linkType = process.platform === "win32" ? "junction" : "dir";
    symlinkSync(rel, current, linkType);
    console.log(`[fetch-runtimes] linked current -> ${rel} (${linkType}, no duplicate copy)`);
    return;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`[fetch-runtimes] symlink failed (${detail}); copying`);
  }
  mkdirSync(current, { recursive: true });
  copyTree(join(platformDir, "node"), join(current, "node"));
  copyTree(join(platformDir, "python"), join(current, "python"));
  for (const name of ["git", "tools"]) {
    if (existsSync(join(platformDir, name))) copyTree(join(platformDir, name), join(current, name));
  }
  if (existsSync(join(platformDir, "archives"))) {
    copyTree(join(platformDir, "archives"), join(current, "archives"));
  }
  copyFileSync(join(platformDir, "manifest.json"), join(current, "manifest.json"));
  ensureUnixExecuteBits(join(current, "node"));
  ensureUnixExecuteBits(join(current, "python"));
  console.log(`[fetch-runtimes] materialised ${current} (copy)`);
}

/**
 * Windows host: unpack the shipped git.7z.exe exactly like first launch does (the SFX's
 * own `-y -o<dir>`, no 7z installed) and run its bash, so a broken archive or an SFX
 * that waits for input fails the build instead of a user's first launch.
 * @param {string} platformDir
 */
function verifyGitArchiveRoundTrip(platformDir) {
  const archive = join(platformDir, "archives", "git.7z.exe");
  if (process.platform !== "win32" || !existsSync(archive)) return;
  const dest = join(tmpdir(), `zeno-git-roundtrip-${Date.now()}`);
  try {
    const started = Date.now();
    execFileSync(archive, ["-y", `-o${join(dest, "git")}`], { stdio: "ignore", timeout: 600_000 });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const out = execFileSync(
      join(dest, "git", "bin", "bash.exe"),
      ["-c", "git --version && echo roundtrip-ok"],
      { encoding: "utf8" },
    ).trim();
    console.log(
      `[fetch-runtimes] git archive round trip (${seconds}s, ${countFiles(join(dest, "git"))} files): ${out.replace(/\s+/g, " ")}`,
    );
    verifyPythonShimInGitBash(platformDir, join(dest, "git", "bin", "bash.exe"), dest);
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
}

/**
 * The agent's `python3` / `python` shims must resolve to the bundled interpreter inside
 * Git Bash. Same script format as `writeAgentShims` in src/main/prsloy/agent-env.ts
 * (`#!/bin/sh` + `exec '<C:/…/python.exe>' "$@"`); agent-env.test.ts pins that format.
 * @param {string} platformDir
 * @param {string} bash
 * @param {string} scratch
 */
function verifyPythonShimInGitBash(platformDir, bash, scratch) {
  const python = findPythonBinary(join(platformDir, "python"));
  if (!python) throw new Error("bundled python missing for the shim smoke");
  const shims = join(scratch, "agent-shims");
  mkdirSync(shims, { recursive: true });
  const target = python.replace(/\\/g, "/");
  for (const name of ["python3", "python"]) {
    writeFileSync(join(shims, name), `#!/bin/sh\nexec '${target}' "$@"\n`);
  }
  const env = { ...process.env };
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "Path";
  env[pathKey] = `${shims};${env[pathKey] ?? ""}`;
  const out = execFileSync(
    bash,
    ["-c", "command -v python3; python3 -c 'import sys; print(sys.executable)'; python --version"],
    { encoding: "utf8", env },
  ).trim();
  const lines = out.split(/\r?\n/);
  if ((lines[1] ?? "").trim().toLowerCase() !== python.toLowerCase()) {
    throw new Error(`python3 shim did not reach the bundled interpreter: ${out}`);
  }
  if (!/Python 3\./.test(lines[2] ?? "")) throw new Error(`python shim failed: ${out}`);
  console.log(`[fetch-runtimes] python shims in Git Bash: ${lines.join(" | ")}`);
}

/**
 * @param {string} root
 * @returns {number}
 */
function countFiles(root) {
  let count = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    if (!dir || !existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) stack.push(join(dir, entry.name));
      else count += 1;
    }
  }
  return count;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const versions = loadVersions();
  const target = resolveTarget(args.platform, args.arch);
  console.log(
    `[fetch-runtimes] target=${target.key} node=${versions.node} python=${versions.python} (${versions.pythonReleaseTag})`,
  );
  const result = await fetchOne(target, versions, args.force);
  materializeCurrent(result.platformDir);
  verifyGitArchiveRoundTrip(result.platformDir);
  console.log("[fetch-runtimes] done");
}

// Only auto-run when executed as a CLI entry (not when imported by tests).
const isCliEntry =
  typeof process.argv[1] === "string" &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isCliEntry) {
  main().catch((error) => {
    console.error("[fetch-runtimes] failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
