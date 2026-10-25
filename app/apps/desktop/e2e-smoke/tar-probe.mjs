/**
 * Probe: does Windows' System32\tar.exe (what runtime-provision.ts uses) extract when the
 * archive and/or destination path has Cyrillic + spaces? Runs the same execFileSync call as
 * the app for each variant and prints JSON (exit code, stderr, files extracted).
 *
 * Usage: node tar-probe.mjs <archive.tar.gz> <cyrillic dir> <ascii dir> [out.json]
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const [archive, cyrDir, asciiDir, outFile] = process.argv.slice(2);
if (!archive || !cyrDir || !asciiDir) {
  console.error("usage: node tar-probe.mjs <archive> <cyrillic dir> <ascii dir>");
  process.exit(2);
}
const root = process.env.SystemRoot || "C:\\Windows";
const tar = existsSync(join(root, "System32", "tar.exe"))
  ? join(root, "System32", "tar.exe")
  : "tar";

mkdirSync(cyrDir, { recursive: true });
mkdirSync(asciiDir, { recursive: true });
const cyrArchive = join(cyrDir, `архив ${basename(archive)}`);
const asciiArchive = join(asciiDir, basename(archive));
copyFileSync(archive, cyrArchive);
copyFileSync(archive, asciiArchive);

function run(name, args, cwd, dest) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  try {
    execFileSync(tar, args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    return { name, ok: true, entries: readdirSync(dest).length };
  } catch (error) {
    return {
      name,
      ok: false,
      status: error.status ?? null,
      stderr: String(error.stderr ?? error.message).slice(0, 600),
      entries: existsSync(dest) ? readdirSync(dest).length : 0,
    };
  }
}

const cyrDest = join(cyrDir, "распаковка");
const asciiDest = join(asciiDir, "out");
const results = [
  run("cyrillic archive -> cyrillic -C", ["-xzf", cyrArchive, "-C", cyrDest], undefined, cyrDest),
  run("ascii archive -> cyrillic -C", ["-xzf", asciiArchive, "-C", cyrDest], undefined, cyrDest),
  run("cyrillic archive -> ascii -C", ["-xzf", cyrArchive, "-C", asciiDest], undefined, asciiDest),
  run("ascii archive -> ascii -C", ["-xzf", asciiArchive, "-C", asciiDest], undefined, asciiDest),
  run(
    "cwd=cyrillic dest, archive by relative name",
    ["-xzf", `..\\${basename(cyrArchive)}`, "-C", "."],
    cyrDest,
    cyrDest,
  ),
];
const report = JSON.stringify({ tar, archive, results }, null, 2);
if (outFile) writeFileSync(outFile, report, "utf8");
console.log(report);
