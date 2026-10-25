import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { listFiles, zipDirectory } from "./zip.ts";

const python3 = (() => {
  try {
    return execFileSync("sh", ["-c", "command -v python3"]).toString().trim();
  } catch {
    return "";
  }
})();

function site() {
  const root = mkdtempSync(join(tmpdir(), "design-zip-"));
  mkdirSync(join(root, "landing", "assets"), { recursive: true });
  writeFileSync(join(root, "landing", "index.html"), "<h1>Зерно</h1>".repeat(50));
  writeFileSync(join(root, "landing", "assets", "логотип.svg"), "<svg/>");
  writeFileSync(join(root, "landing", ".DS_Store"), "x");
  writeFileSync(join(root, "landing", "assets", "tiny.bin"), Buffer.from([1, 2, 3]));
  return root;
}

describe("listFiles", () => {
  it("walks the site in order, skipping dotfiles", () => {
    expect(listFiles(site())).toEqual([
      "landing/assets/tiny.bin",
      "landing/assets/логотип.svg",
      "landing/index.html",
    ]);
  });
});

describe("zipDirectory", () => {
  it("writes the zip signatures and one entry per file", () => {
    const zip = zipDirectory(site(), "site");
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    const end = zip.length - 22;
    expect(zip.readUInt32LE(end)).toBe(0x06054b50);
    expect(zip.readUInt16LE(end + 10)).toBe(3);
  });

  it.skipIf(!python3)("is read back byte for byte by an independent unzip (Python zipfile)", () => {
    const root = site();
    const out = join(root, "out.zip");
    writeFileSync(out, zipDirectory(root, "site"));
    const listing = execFileSync(python3, [
      "-c",
      "import sys, zipfile, json; z = zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; " +
        "print(json.dumps({n: z.read(n).decode('utf-8', 'replace') for n in z.namelist()}, ensure_ascii=False))",
      out,
    ]).toString();
    const files = JSON.parse(listing) as Record<string, string>;
    expect(Object.keys(files)).toEqual([
      "site/landing/assets/tiny.bin",
      "site/landing/assets/логотип.svg",
      "site/landing/index.html",
    ]);
    expect(files["site/landing/index.html"]).toBe("<h1>Зерно</h1>".repeat(50));
    expect(files["site/landing/assets/логотип.svg"]).toBe("<svg/>");
  });
});
