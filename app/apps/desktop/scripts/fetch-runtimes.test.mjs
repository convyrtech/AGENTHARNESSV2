/**
 * Unit tests for fetch-runtimes pure helpers + prune (no network).
 * Run: node apps/desktop/scripts/fetch-runtimes.test.mjs
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  dedupeIdenticalFiles,
  gitDistMeta,
  loadVersions,
  nodeDistMeta,
  packShippingArchives,
  pruneGitRuntime,
  searchToolsDistMeta,
  pruneNodeRuntime,
  prunePythonRuntime,
  PYTHON_PRUNE_REV,
  pythonPruneRev,
  pythonDistMeta,
  resolveTarget,
  resolveTarBinary,
} from "./fetch-runtimes.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VERSIONS_PATH = join(__dirname, "..", "runtimes", "versions.json");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

// ── versions.json pin file ──────────────────────────────────────────────────
{
  const v = loadVersions(VERSIONS_PATH);
  assert(typeof v.node === "string" && v.node.length > 0, "node version pinned");
  assert(typeof v.python === "string" && v.python.length > 0, "python version pinned");
  assert(
    typeof v.pythonReleaseTag === "string" && v.pythonReleaseTag.length > 0,
    "pythonReleaseTag pinned",
  );
  // Sanity: matches engines.node major 22 line used by desktop
  assert(/^\d+\.\d+\.\d+$/.test(v.node), `node semver-like: ${v.node}`);
  assert(/^\d+\.\d+\.\d+$/.test(v.python), `python semver-like: ${v.python}`);
}

// ── resolveTarget: platform matrix ──────────────────────────────────────────
{
  const cases = [
    { platform: "darwin", arch: "arm64", key: "darwin-arm64", os: "darwin", a: "arm64" },
    { platform: "mac", arch: "x64", key: "darwin-x64", os: "darwin", a: "x64" },
    { platform: "macos", arch: "x86_64", key: "darwin-x64", os: "darwin", a: "x64" },
    { platform: "linux", arch: "x64", key: "linux-x64", os: "linux", a: "x64" },
    { platform: "linux", arch: "aarch64", key: "linux-arm64", os: "linux", a: "arm64" },
    { platform: "win32", arch: "x64", key: "win32-x64", os: "win32", a: "x64" },
    { platform: "windows", arch: "x64", key: "win32-x64", os: "win32", a: "x64" },
    // win arm64 currently falls back to x64 assets
    { platform: "win32", arch: "arm64", key: "win32-x64", os: "win32", a: "x64" },
  ];
  for (const c of cases) {
    const t = resolveTarget(c.platform, c.arch);
    assertEqual(t.os, c.os, `${c.platform}/${c.arch} os`);
    assertEqual(t.arch, c.a, `${c.platform}/${c.arch} arch`);
    assertEqual(t.key, c.key, `${c.platform}/${c.arch} key`);
  }
  let threw = false;
  try {
    resolveTarget("solaris", "x64");
  } catch {
    threw = true;
  }
  assert(threw, "unsupported platform throws");
}

// ── dist URL builders (cross-platform assets) ───────────────────────────────
{
  const versions = { node: "22.19.0", python: "3.12.13", pythonReleaseTag: "20260807" };

  const macNode = nodeDistMeta({ os: "darwin", arch: "arm64" }, versions);
  assertEqual(
    macNode.url,
    "https://nodejs.org/dist/v22.19.0/node-v22.19.0-darwin-arm64.tar.gz",
    "mac node url",
  );
  assertEqual(macNode.kind, "tar.gz", "mac node kind");

  const winNode = nodeDistMeta({ os: "win32", arch: "x64" }, versions);
  assert(winNode.url.endsWith("node-v22.19.0-win-x64.zip"), `win node url zip: ${winNode.url}`);
  assertEqual(winNode.kind, "zip", "win node kind");

  const linuxNode = nodeDistMeta({ os: "linux", arch: "x64" }, versions);
  assert(
    linuxNode.url.includes("node-v22.19.0-linux-x64.tar.gz"),
    `linux node url: ${linuxNode.url}`,
  );

  const macPy = pythonDistMeta({ os: "darwin", arch: "arm64" }, versions);
  assert(macPy.url.includes("aarch64-apple-darwin"), `mac python triple: ${macPy.url}`);
  assert(macPy.url.includes("install_only_stripped"), `python uses stripped install: ${macPy.url}`);
  assert(
    macPy.archiveName.includes("cpython-3.12.13+20260807"),
    `python archive name: ${macPy.archiveName}`,
  );

  const winPy = pythonDistMeta({ os: "win32", arch: "x64" }, versions);
  assert(winPy.url.includes("x86_64-pc-windows-msvc"), `win python triple: ${winPy.url}`);

  const linuxPy = pythonDistMeta({ os: "linux", arch: "arm64" }, versions);
  assert(
    linuxPy.url.includes("aarch64-unknown-linux-gnu"),
    `linux arm python triple: ${linuxPy.url}`,
  );
}

// ── pruneNodeRuntime drops include/share, keeps bin/node ────────────────────
{
  const root = mkdtempSync(join(tmpdir(), "zeno-prune-node-"));
  try {
    const nodeRoot = join(root, "node");
    mkdirSync(join(nodeRoot, "bin"), { recursive: true });
    mkdirSync(join(nodeRoot, "include"), { recursive: true });
    mkdirSync(join(nodeRoot, "share"), { recursive: true });
    writeFileSync(join(nodeRoot, "bin", "node"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(nodeRoot, "include", "node.h"), "/* big headers */\n");
    writeFileSync(join(nodeRoot, "share", "doc.txt"), "docs\n");
    writeFileSync(join(nodeRoot, "CHANGELOG.md"), "# changelog\n");

    pruneNodeRuntime(nodeRoot);

    assert(existsSync(join(nodeRoot, "bin", "node")), "node binary kept");
    assert(!existsSync(join(nodeRoot, "include")), "include removed");
    assert(!existsSync(join(nodeRoot, "share")), "share removed");
    assert(!existsSync(join(nodeRoot, "CHANGELOG.md")), "changelog removed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── prunePythonRuntime drops Tcl/Tk + idle, keeps python bin ────────────────
{
  const root = mkdtempSync(join(tmpdir(), "zeno-prune-py-"));
  try {
    const pyRoot = join(root, "python");
    const bin = join(pyRoot, "bin");
    const lib = join(pyRoot, "lib", "python3.12");
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(lib, "idlelib"), { recursive: true });
    mkdirSync(join(lib, "encodings"), { recursive: true });
    mkdirSync(join(pyRoot, "lib", "tcl9.0"), { recursive: true });
    mkdirSync(join(pyRoot, "include"), { recursive: true });
    writeFileSync(join(bin, "python3"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(bin, "idle3"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(lib, "idlelib", "x.py"), "pass\n");
    writeFileSync(join(lib, "encodings", "utf_8.py"), "pass\n");
    writeFileSync(join(pyRoot, "lib", "tcl9.0", "init.tcl"), "# tcl\n");
    writeFileSync(join(pyRoot, "include", "Python.h"), "/* headers */\n");
    mkdirSync(join(lib, "__pycache__"), { recursive: true });
    writeFileSync(join(lib, "__pycache__", "x.pyc"), "\0");
    const wheel = join(lib, "ensurepip", "_bundled", "pip-25.0.1-py3-none-any.whl");
    mkdirSync(dirname(wheel), { recursive: true });
    writeFileSync(wheel, "PK");

    prunePythonRuntime(pyRoot);

    assert(existsSync(join(bin, "python3")), "python3 kept");
    // `python -m venv` installs this wheel: without it the app had no venv and no pip on Linux.
    assert(existsSync(wheel), "ensurepip's pip wheel kept");
    assert(existsSync(join(lib, "encodings", "utf_8.py")), "stdlib encodings kept");
    assert(!existsSync(join(lib, "idlelib")), "idlelib removed");
    assert(!existsSync(join(pyRoot, "lib", "tcl9.0")), "tcl removed");
    assert(!existsSync(join(pyRoot, "include")), "include removed");
    assert(!existsSync(join(bin, "idle3")), "idle3 bin removed");
    assert(!existsSync(join(lib, "__pycache__")), "pycache removed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── prunePythonRuntime on the Windows layout keeps the stdlib (Lib == lib on NTFS) ──
{
  const root = mkdtempSync(join(tmpdir(), "zeno-prune-pywin-"));
  try {
    const pyRoot = join(root, "python");
    const stdlib = join(pyRoot, "Lib");
    mkdirSync(join(stdlib, "sqlite3"), { recursive: true });
    mkdirSync(join(stdlib, "tkinter"), { recursive: true });
    mkdirSync(join(stdlib, "idlelib"), { recursive: true });
    mkdirSync(join(pyRoot, "tcl", "tcl8.6"), { recursive: true });
    writeFileSync(join(pyRoot, "python.exe"), "MZ");
    for (const name of ["os.py", "threading.py", "tkinter/__init__.py", "idlelib/x.py"]) {
      writeFileSync(join(stdlib, name), "pass\n");
    }
    writeFileSync(join(stdlib, "sqlite3", "__init__.py"), "pass\n");
    mkdirSync(join(stdlib, "__pycache__"), { recursive: true });
    writeFileSync(join(stdlib, "__pycache__", "os.cpython-312.pyc"), "\0");

    prunePythonRuntime(pyRoot);

    assert(!existsSync(join(stdlib, "__pycache__")), "Windows __pycache__ removed");

    assert(existsSync(join(stdlib, "threading.py")), "threading.py kept");
    assert(existsSync(join(stdlib, "sqlite3", "__init__.py")), "sqlite3 kept");
    assert(existsSync(join(stdlib, "os.py")), "os.py kept");
    assert(!existsSync(join(stdlib, "tkinter")), "tkinter removed");
    assert(!existsSync(join(stdlib, "idlelib")), "idlelib removed");
    assert(!existsSync(join(pyRoot, "tcl")), "tcl removed");
    assert(PYTHON_PRUNE_REV >= 2, "prune revision bumped for the Windows stdlib fix");
    assert(pythonPruneRev("win32") === PYTHON_PRUNE_REV, "Windows keeps its revision");
    assert(pythonPruneRev("linux") > PYTHON_PRUNE_REV, "Linux/macOS re-extract with the pip wheel");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── invalid versions file ───────────────────────────────────────────────────
{
  const bad = join(mkdtempSync(join(tmpdir(), "zeno-ver-")), "versions.json");
  writeFileSync(bad, JSON.stringify({ node: "1.0.0" }));
  let threw = false;
  try {
    loadVersions(bad);
  } catch {
    threw = true;
  }
  assert(threw, "incomplete versions.json throws");
  rmSync(dirname(bad), { recursive: true, force: true });
}

// ── resolveTarBinary: Windows must use System32 bsdtar, not Git GNU tar ─────
{
  const unix = resolveTarBinary("linux", {});
  assert(unix === "tar", `unix tar: ${unix}`);
  const win = resolveTarBinary("win32", { SystemRoot: "C:\\Windows" });
  assert(win === "C:\\Windows\\System32\\tar.exe" || win === "tar", `win tar: ${win}`);
}

// ── packShippingArchives produces node/python tar.gz ────────────────────────
{
  const root = mkdtempSync(join(tmpdir(), "zeno-pack-arch-"));
  try {
    mkdirSync(join(root, "node", "bin"), { recursive: true });
    mkdirSync(join(root, "python", "bin"), { recursive: true });
    writeFileSync(join(root, "node", "bin", "node"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(root, "python", "bin", "python3"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(
      join(root, "manifest.json"),
      JSON.stringify({ node: "22.19.0", python: "3.12.13", key: "test" }),
    );
    packShippingArchives(root);
    assert(existsSync(join(root, "archives", "node.tar.gz")), "node archive");
    assert(existsSync(join(root, "archives", "python.tar.gz")), "python archive");
    const man = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
    assert(man.archives?.node === "archives/node.tar.gz", "manifest node archive path");
    assert(man.archives?.python === "archives/python.tar.gz", "manifest python archive path");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── Windows: PortableGit + rg/fd pins and URLs; none on other targets ──────
{
  const v = loadVersions(VERSIONS_PATH);
  assert(/^\d+\.\d+\.\d+$/.test(v.git ?? ""), `git pinned: ${v.git}`);
  const win = { os: "win32", arch: "x64" };
  const git = gitDistMeta(win, { ...v, git: "2.51.0", gitTag: "v2.51.0.windows.1" });
  assertEqual(
    git?.url,
    "https://github.com/git-for-windows/git/releases/download/v2.51.0.windows.1/PortableGit-2.51.0-64-bit.7z.exe",
    "portable git url",
  );
  assertEqual(gitDistMeta({ os: "linux", arch: "x64" }, v), undefined, "no git on linux");
  const tools = searchToolsDistMeta(win, { ...v, ripgrep: "14.1.1", fd: "10.2.0" });
  assertEqual(
    tools.map((t) => t.url).join(" "),
    "https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-x86_64-pc-windows-msvc.zip " +
      "https://github.com/sharkdp/fd/releases/download/v10.2.0/fd-v10.2.0-x86_64-pc-windows-msvc.zip",
    "rg/fd urls",
  );
  assertEqual(searchToolsDistMeta({ os: "darwin", arch: "arm64" }, v).length, 0, "no tools on mac");
}

// ── pruneGitRuntime keeps bash/git, drops docs + Tcl/Tk GUIs ───────────────
{
  const root = mkdtempSync(join(tmpdir(), "zeno-prune-git-"));
  try {
    const touch = (...parts) => {
      mkdirSync(join(root, ...parts.slice(0, -1)), { recursive: true });
      writeFileSync(join(root, ...parts), "x");
    };
    touch("bin", "bash.exe");
    touch("cmd", "git.exe");
    touch("cmd", "gitk.exe");
    touch("usr", "bin", "bash.exe");
    touch("usr", "share", "doc", "readme");
    touch("usr", "share", "vim", "vim91", "defaults.vim");
    touch("usr", "bin", "vim.exe");
    touch("mingw64", "share", "doc", "git-doc", "index.html");
    touch("mingw64", "lib", "tcl8.6", "init.tcl");
    touch("mingw64", "lib", "tk8.6", "tk.tcl");
    touch("mingw64", "lib", "libcurl.a");
    touch("mingw64", "libexec", "git-core", "git-gui.tcl");
    touch("mingw64", "libexec", "git-core", "git-add.exe");
    pruneGitRuntime(root);
    for (const kept of [
      ["bin", "bash.exe"],
      ["cmd", "git.exe"],
      ["usr", "bin", "bash.exe"],
      ["mingw64", "lib", "libcurl.a"],
      ["mingw64", "libexec", "git-core", "git-add.exe"],
    ]) {
      assert(existsSync(join(root, ...kept)), `git prune keeps ${kept.join("/")}`);
    }
    for (const gone of [
      ["cmd", "gitk.exe"],
      ["usr", "share", "vim"],
      ["usr", "bin", "vim.exe"],
      ["usr", "share", "doc"],
      ["mingw64", "share", "doc"],
      ["mingw64", "lib", "tcl8.6"],
      ["mingw64", "lib", "tk8.6"],
      ["mingw64", "libexec", "git-core", "git-gui.tcl"],
    ]) {
      assert(!existsSync(join(root, ...gone)), `git prune drops ${gone.join("/")}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── packShippingArchives ships git.7z.exe as-is and packs tools/ ────────────
{
  const root = mkdtempSync(join(tmpdir(), "zeno-pack-git-"));
  try {
    mkdirSync(join(root, "node", "bin"), { recursive: true });
    mkdirSync(join(root, "tools"), { recursive: true });
    writeFileSync(join(root, "node", "bin", "node"), "x");
    writeFileSync(join(root, "git.7z.exe"), "sfx");
    writeFileSync(join(root, "tools", "rg.exe"), "x");
    writeFileSync(join(root, "manifest.json"), JSON.stringify({ node: "22.19.0", git: "2.51.0" }));
    packShippingArchives(root);
    const man = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
    assertEqual(man.archives?.git, "archives/git.7z.exe", "manifest git archive path");
    assertEqual(
      readFileSync(join(root, "archives", "git.7z.exe"), "utf8"),
      "sfx",
      "PortableGit SFX shipped as-is",
    );
    assertEqual(man.archives?.tools, "archives/tools.tar.gz", "manifest tools archive path");
    assertEqual(man.archives?.python, undefined, "no python archive without python/");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── dedupeIdenticalFiles hard-links identical big files only ───────────────
{
  const root = mkdtempSync(join(tmpdir(), "zeno-dedupe-"));
  try {
    const big = "x".repeat(100 * 1024);
    mkdirSync(join(root, "a"), { recursive: true });
    writeFileSync(join(root, "git.exe"), big);
    writeFileSync(join(root, "a", "git-add.exe"), big);
    writeFileSync(join(root, "a", "other.exe"), "y".repeat(100 * 1024));
    writeFileSync(join(root, "small1"), "s");
    writeFileSync(join(root, "small2"), "s");
    const saved = dedupeIdenticalFiles(root);
    assertEqual(saved, 100 * 1024, "dedupe saved bytes");
    assertEqual(
      statSync(join(root, "git.exe")).ino,
      statSync(join(root, "a", "git-add.exe")).ino,
      "identical files share an inode",
    );
    assert(
      statSync(join(root, "a", "other.exe")).ino !== statSync(join(root, "git.exe")).ino,
      "different content untouched",
    );
    assertEqual(readFileSync(join(root, "a", "git-add.exe"), "utf8"), big, "content intact");
    assertEqual(dedupeIdenticalFiles(root), 0, "second pass is a no-op");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Touch pathToFileURL so unused-import tools stay quiet if tree-shaken differently
void pathToFileURL;
// Confirm versions.json is real JSON on disk
JSON.parse(readFileSync(VERSIONS_PATH, "utf8"));

console.log("fetch-runtimes.test.mjs: ok");
