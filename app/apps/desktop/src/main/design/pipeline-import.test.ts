import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  findPipelineRoot,
  importPipeline,
  NOT_TOOLS,
  PIPELINE_REQUIRED,
} from "./pipeline-import.ts";
import { readZip, safeEntryName, ZipRefused, zipDirectory, zipFiles } from "./zip.ts";

const STUB = join(import.meta.dirname, "../../../e2e/design/stub-pipeline");
const LIMITS = { files: 50, bytes: 4 << 20, fileBytes: 1 << 20 };

function scratch() {
  const root = mkdtempSync(join(tmpdir(), "pipeline-import-"));
  // the owner's Windows profile: space and Cyrillic in the path
  const userData = join(root, "Иван Петров", "AppData", "PRSLOY");
  return { root, dest: join(userData, "design", "design-pipeline") };
}

function zipOf(entries: [string, string][], file: string, mode?: number): string {
  writeFileSync(
    file,
    zipFiles(
      entries.map(([name, text]) => ({
        name,
        data: Buffer.from(text),
        ...(mode === undefined ? {} : { mode }),
      })),
    ),
  );
  return file;
}

describe("safeEntryName", () => {
  it("keeps plain relative paths and refuses anything that climbs out", () => {
    expect(safeEntryName("design-pipeline-main/tools/flow.py")).toBe(
      "design-pipeline-main/tools/flow.py",
    );
    expect(safeEntryName("./a//b.txt")).toBe("a/b.txt");
    for (const bad of [
      "../x",
      "a/../../x",
      "/etc/passwd",
      "C:/x",
      "a\\..\\x",
      "a/b:stream",
      "",
      "a\0b",
    ]) {
      expect(safeEntryName(bad)).toBeUndefined();
    }
  });
});

describe("findPipelineRoot", () => {
  it("finds the required files at the root or one folder down", () => {
    expect(findPipelineRoot(PIPELINE_REQUIRED)).toBe("");
    expect(findPipelineRoot(PIPELINE_REQUIRED.map((f) => `design-pipeline-main/${f}`))).toBe(
      "design-pipeline-main/",
    );
    expect(findPipelineRoot(["x/tools/flow.py", "x/AGENTS.md"])).toBeUndefined();
    expect(findPipelineRoot(PIPELINE_REQUIRED.map((f) => `a/b/${f}`))).toBeUndefined();
  });
});

describe("importPipeline", () => {
  it("takes GitHub's «Download ZIP» (one top folder) into a Cyrillic userData", () => {
    const { root, dest } = scratch();
    const zip = join(root, "design-pipeline-main.zip");
    writeFileSync(zip, zipDirectory(STUB, "design-pipeline-main"));
    expect(importPipeline(zip, dest)).toEqual({ ok: true, files: expect.any(Number) });
    for (const f of PIPELINE_REQUIRED) expect(existsSync(join(dest, ...f.split("/")))).toBe(true);
    expect(readFileSync(join(dest, "tools", "flow.py"))).toEqual(
      readFileSync(join(STUB, "tools", "flow.py")),
    );
    expect(JSON.parse(readFileSync(join(dest, ".imported.json"), "utf8"))).toMatchObject({
      from: "design-pipeline-main.zip",
    });
    // nothing left behind next to the copy
    expect(readdirSync(join(dest, ".."))).toEqual(["design-pipeline"]);
  });

  it("takes the pinned-commit archive (top folder design-pipeline-<sha>/)", () => {
    // what the owner gets: github.com/convyrtech/design-pipeline/archive/<sha>.zip
    const sha = "39fcac42db4bd344c7d9747a5903cc18c9d87718";
    const { root, dest } = scratch();
    const zip = join(root, `${sha}.zip`);
    writeFileSync(zip, zipDirectory(STUB, `design-pipeline-${sha}`));
    expect(importPipeline(zip, dest)).toEqual({ ok: true, files: expect.any(Number) });
    for (const f of PIPELINE_REQUIRED) expect(existsSync(join(dest, ...f.split("/")))).toBe(true);
    expect(existsSync(join(dest, `design-pipeline-${sha}`))).toBe(false);
  });

  it("takes the unpacked folder, or any file picked inside it", () => {
    const { root, dest } = scratch();
    const folder = join(root, "Загрузки", "design-pipeline-main");
    mkdirSync(join(folder, "tools"), { recursive: true });
    mkdirSync(join(folder, "__pycache__"));
    for (const f of [...PIPELINE_REQUIRED, "__pycache__/x.pyc"]) writeFileSync(join(folder, f), f);
    symlinkSync(join(root, "Загрузки"), join(folder, "loop"));
    expect(importPipeline(folder, dest)).toEqual({ ok: true, files: 3 });
    expect(existsSync(join(dest, "__pycache__"))).toBe(false);
    expect(existsSync(join(dest, "loop"))).toBe(false); // symlinks are not followed
    expect(importPipeline(join(folder, "tools", "flow.py"), dest)).toEqual({ ok: true, files: 3 });
  });

  it("refuses folders and zips that are not the tools, leaving the old copy in place", () => {
    const { root, dest } = scratch();
    const good = join(root, "good.zip");
    writeFileSync(good, zipDirectory(STUB));
    expect(importPipeline(good, dest).ok).toBe(true);
    const before = readFileSync(join(dest, "PIPELINE.md"));

    mkdirSync(join(root, "фото"));
    writeFileSync(join(root, "фото", "кот.jpg"), "jpg");
    expect(importPipeline(join(root, "фото"), dest)).toEqual({ ok: false, error: NOT_TOOLS });
    const junk = zipOf([["readme.txt", "hi"]], join(root, "junk.zip"));
    expect(importPipeline(junk, dest)).toEqual({ ok: false, error: NOT_TOOLS });
    writeFileSync(join(root, "broken.zip"), "PK\x03\x04 not really");
    expect(importPipeline(join(root, "broken.zip"), dest)).toMatchObject({
      ok: false,
      error: expect.stringContaining("Этот файл не подходит"),
    });
    expect(readFileSync(join(dest, "PIPELINE.md"))).toEqual(before);
  });

  it("refuses zip-slip and symlinks before writing anything", () => {
    const { root, dest } = scratch();
    const files: [string, string][] = PIPELINE_REQUIRED.map((f) => [`p/${f}`, "x"]);
    const slip = zipOf([...files, ["p/../../../outside.txt", "pwned"]], join(root, "slip.zip"));
    expect(importPipeline(slip, dest)).toMatchObject({
      ok: false,
      error: expect.stringContaining("за папку"),
    });
    const link = zipOf(files, join(root, "link.zip"), 0o120777);
    expect(importPipeline(link, dest)).toMatchObject({
      ok: false,
      error: expect.stringContaining("ссылка"),
    });
    expect(existsSync(dest)).toBe(false);
    expect(readdirSync(root).filter((n) => !n.endsWith(".zip"))).toEqual([]); // not even the userData folders
    expect(existsSync(join(root, "outside.txt"))).toBe(false);
  });

  it("refuses too many files, too many bytes and a bomb", () => {
    const { root, dest } = scratch();
    const files: [string, string][] = PIPELINE_REQUIRED.map((f) => [f, "x"]);
    const many = zipOf(
      [...files, ...Array.from({ length: 60 }, (_, i): [string, string] => [`n/${i}.txt`, "x"])],
      join(root, "many.zip"),
    );
    expect(importPipeline(many, dest, LIMITS)).toMatchObject({
      error: expect.stringContaining("больше 50 файлов"),
    });
    const big = zipOf([...files, ["big.bin", "a".repeat(1_500_000)]], join(root, "big.zip"));
    expect(importPipeline(big, dest, LIMITS)).toMatchObject({
      error: expect.stringContaining("файл больше 1 МБ"),
    });
    // a bomb: the directory promises 10 bytes, the deflate stream unpacks to 1 MB
    const zip = zipFiles([{ name: "AGENTS.md", data: Buffer.alloc(1 << 20) }]);
    const cd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt32LE(10, cd + 24);
    expect(() => readZip(zip, LIMITS)).toThrow(ZipRefused);
    expect(existsSync(dest)).toBe(false);
  });
});
