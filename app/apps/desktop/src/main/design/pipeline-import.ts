/**
 * «У меня есть файл инструментов»: the owner's own copy of design-pipeline (private, so the public
 * installer ships without it) becomes userData/design/design-pipeline. Accepted: the zip GitHub
 * gives for «Code → Download ZIP» (one top folder, design-pipeline-main/), the unpacked folder, or
 * any file inside that folder (Windows and Linux dialogs pick a file or a folder, not both).
 *
 * Nothing is written until the whole source is read and checked: required files, zip-slip,
 * symlinks, sizes. Files are written one by one (fs.cpSync silently copies nothing into
 * Cyrillic paths on Windows), into a temp folder that replaces the old copy at the end.
 * Node built-ins only: scripts/design-smoke.mts runs it on Windows without Electron.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { readZip, safeEntryName, ZipRefused, type ZipLimits } from "./zip.ts";

export const PIPELINE_REQUIRED = ["tools/flow.py", "AGENTS.md", "PIPELINE.md"] as const;
export const NOT_TOOLS = "Это не папка инструментов дизайна";
/** The real pipeline is ~2 MB in ~100 files. */
export const PIPELINE_LIMITS: ZipLimits = { files: 4000, bytes: 64 << 20, fileBytes: 32 << 20 };
/** Same as the bundle (scripts/fetch-design.mjs): not needed at run time. */
const SKIP = new Set([".git", "__pycache__", "node_modules", ".DS_Store", "examples"]);

export type PipelineImport = { ok: true; files: number } | { ok: false; error: string };
type Entry = { name: string; data: Buffer };

function isZip(path: string): boolean {
  if (path.toLowerCase().endsWith(".zip")) return true;
  try {
    return readFileSync(path)
      .subarray(0, 4)
      .equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  } catch {
    return false;
  }
}

/** Files under `dir` as `/` paths; symlinks are not followed, SKIP names are left out. */
function readDir(dir: string, limits: ZipLimits): Entry[] {
  const out: Entry[] = [];
  let total = 0;
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      if (SKIP.has(name)) continue;
      const full = join(d, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) {
        if (out.length >= limits.files)
          throw new ZipRefused(`в папке больше ${limits.files} файлов`);
        if (st.size > limits.fileBytes)
          throw new ZipRefused(`файл больше ${limits.fileBytes >> 20} МБ: ${name}`);
        total += st.size;
        if (total > limits.bytes) throw new ZipRefused(`папка больше ${limits.bytes >> 20} МБ`);
        out.push({ name: relative(dir, full).split(sep).join("/"), data: readFileSync(full) });
      }
    }
  };
  walk(dir);
  return out;
}

/** "" or "<top>/" where all required files are: the root itself or one folder down. */
export function findPipelineRoot(names: Iterable<string>): string | undefined {
  const set = new Set(names);
  const has = (prefix: string) => PIPELINE_REQUIRED.every((r) => set.has(prefix + r));
  if (has("")) return "";
  const tops = new Set(
    [...set].filter((n) => n.includes("/")).map((n) => n.slice(0, n.indexOf("/") + 1)),
  );
  return [...tops].sort().find(has);
}

/** The folder a picked non-zip path stands for: itself, or up to two parents of a picked file. */
function folderFor(picked: string): string | undefined {
  let dir = statSync(picked).isDirectory() ? picked : dirname(picked);
  for (let up = 0; up < 3; up++) {
    if (PIPELINE_REQUIRED.every((r) => existsSync(join(dir, ...r.split("/"))))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** Read and check `picked` (zip, folder, or a file in the folder); entries relative to the pipeline root. */
export function readPipelineSource(picked: string, limits = PIPELINE_LIMITS): Entry[] {
  if (isZip(picked)) {
    const all = readZip(readFileSync(picked), limits);
    const root = findPipelineRoot(all.map((e) => e.name));
    if (root === undefined) throw new ZipRefused(NOT_TOOLS);
    return all
      .filter((e) => e.name.startsWith(root))
      .map((e) => ({ name: e.name.slice(root.length), data: e.data }))
      .filter((e) => !e.name.split("/").some((p) => SKIP.has(p)));
  }
  const dir = folderFor(picked);
  if (!dir) throw new ZipRefused(NOT_TOOLS);
  return readDir(dir, limits);
}

/** Write `entries` as the folder `dest`, replacing what was there only once all are written. */
export function writePipeline(entries: Entry[], dest: string): void {
  const root = resolve(dest);
  const tmp = `${root}.tmp-${process.pid}-${Date.now()}`;
  rmSync(tmp, { recursive: true, force: true });
  try {
    for (const e of entries) {
      const name = safeEntryName(e.name);
      const target = name ? resolve(tmp, ...name.split("/")) : "";
      // second line of defence: whatever the reader let through cannot land outside tmp
      if (!name || !target.startsWith(tmp + sep))
        throw new ZipRefused(`путь выходит за папку: ${e.name}`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, e.data);
    }
    const old = `${root}.old-${process.pid}-${Date.now()}`;
    if (existsSync(root)) renameSync(root, old);
    renameSync(tmp, root);
    rmSync(old, { recursive: true, force: true });
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true });
    throw error;
  }
}

export function importPipeline(
  picked: string,
  dest: string,
  limits = PIPELINE_LIMITS,
): PipelineImport {
  try {
    const entries = readPipelineSource(picked, limits);
    writePipeline(entries, dest);
    writeFileSync(
      join(dest, ".imported.json"),
      `${JSON.stringify({ from: basename(picked), at: new Date().toISOString(), files: entries.length })}\n`,
    );
    return { ok: true, files: entries.length };
  } catch (error) {
    if (error instanceof ZipRefused) {
      return {
        ok: false,
        error: error.message === NOT_TOOLS ? NOT_TOOLS : `Этот файл не подходит: ${error.message}`,
      };
    }
    return {
      ok: false,
      error: `Не получилось сохранить инструменты: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
