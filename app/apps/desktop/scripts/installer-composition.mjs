/**
 * What the Windows installer is made of, and what could safely go (measure only — nothing is
 * removed here). Walks the unpacked app (`release/app/win-unpacked`), reads the app.asar header
 * and the runtime tar.gz archives in-process, and writes JSON + a Markdown table.
 *
 * Sizes: `raw` = bytes on disk after install; `gz` = gzip -6 estimate of the same bytes, close to
 * what each part costs inside the (LZMA) installer. Archives already compressed count as is.
 *
 * Usage: node scripts/installer-composition.mjs <win-unpacked dir> <installer.exe> <out dir>
 */
import {
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  mkdirSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

const [unpacked, installer, outDir] = process.argv.slice(2);
if (!unpacked || !outDir) {
  console.error("usage: node installer-composition.mjs <win-unpacked> <installer.exe> <out dir>");
  process.exit(2);
}

const MB = 1024 * 1024;
const mb = (n) => Math.round((n / MB) * 10) / 10;
const gzSize = (buf) => (buf.length === 0 ? 0 : gzipSync(buf, { level: 6 }).length);

/** Candidates for removal: id → test on a POSIX-style relative path. */
const CANDIDATES = {
  "locales (not ru / en-US)": (p) => /(^|\/)locales\/(?!ru\.pak$|en-US\.pak$)[^/]+\.pak$/.test(p),
  "*.pdb": (p) => p.endsWith(".pdb"),
  "__pycache__ / *.pyc": (p) => /(^|\/)__pycache__\//.test(p) || p.endsWith(".pyc"),
  "test / tests folders": (p) => /(^|\/)(tests?|__tests__)\//.test(p),
  "C headers / import libs": (p) =>
    /(^|\/)include\//.test(p) || p.endsWith(".lib") || p.endsWith(".h"),
  "docs / man / *.md": (p) =>
    /(^|\/)(docs?|man|html)\//.test(p) || (/\.(md|markdown)$/i.test(p) && !/license/i.test(p)),
  "ensurepip wheels": (p) => /ensurepip\/_bundled\//.test(p),
  "tcl / tk / idle": (p) => /(^|\/)(tcl|tk\d|idlelib|tkinter|turtledemo)(\/|$)/.test(p),
};

const groups = []; // { group, part, raw, gz, files }
const candidates = Object.fromEntries(
  Object.keys(CANDIDATES).map((k) => [k, { raw: 0, gz: 0, files: 0, where: {} }]),
);

function addCandidate(path, raw, gz, where) {
  for (const [name, test] of Object.entries(CANDIDATES)) {
    if (!test(path)) continue;
    const c = candidates[name];
    c.raw += raw;
    c.gz += gz;
    c.files += 1;
    c.where[where] = (c.where[where] ?? 0) + raw;
  }
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

const posix = (p) => p.split(sep).join("/");

// ── app.asar: header JSON → per-file sizes (file bytes are read for the gzip estimate) ──
function readAsar(file) {
  const fd = openSync(file, "r");
  const head = Buffer.alloc(16);
  readSync(fd, head, 0, 16, 0);
  const headerSize = head.readUInt32LE(4);
  const jsonLen = head.readUInt32LE(12);
  const json = Buffer.alloc(jsonLen);
  readSync(fd, json, 0, jsonLen, 16);
  const header = JSON.parse(json.toString("utf8"));
  const base = 8 + headerSize;
  const files = [];
  const visit = (node, prefix) => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (child.files) visit(child, path);
      else if (!child.unpacked && typeof child.size === "number") {
        const buf = Buffer.alloc(child.size);
        if (child.size) readSync(fd, buf, 0, child.size, base + Number(child.offset));
        files.push({ path, raw: child.size, gz: gzSize(buf) });
      }
    }
  };
  visit(header, "");
  closeSync(fd);
  return files;
}

// ── tar(.gz): ustar / pax / GNU long names ──
function readTarGz(file) {
  const tar = gunzipSync(readFileSync(file));
  const files = [];
  let offset = 0;
  let longName = null;
  let paxPath = null;
  const str = (start, len) => tar.toString("utf8", start, start + len).split("\0")[0] ?? "";
  while (offset + 512 <= tar.length) {
    const name = str(offset, 100);
    if (!name) break;
    const size = parseInt(str(offset + 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(tar[offset + 156] || 48);
    const prefix =
      tar.toString("utf8", offset + 257, offset + 262) === "ustar" ? str(offset + 345, 155) : "";
    const dataStart = offset + 512;
    const data = tar.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / 512) * 512;
    if (type === "L") {
      longName = data.toString("utf8").split("\0")[0] ?? "";
      continue;
    }
    if (type === "x") {
      const m = /\d+ path=([^\n]+)\n/.exec(data.toString("utf8"));
      paxPath = m ? m[1] : null;
      continue;
    }
    const path = paxPath ?? longName ?? (prefix ? `${prefix}/${name}` : name);
    longName = null;
    paxPath = null;
    if (type === "0" || type === "\0" || type === "7")
      files.push({ path, raw: size, gz: gzSize(data) });
  }
  return files;
}

/** First `depth` path segments as the part name. */
const firstSegments = (depth) => (path) => path.split("/").slice(0, depth).join("/") || "(root)";

/** Sum files into parts (keyOf: path → part name) and count removal candidates. */
function summarizeFiles(group, files, keyOf, where) {
  const parts = new Map();
  for (const f of files) {
    const key = keyOf(f.path);
    const p = parts.get(key) ?? { raw: 0, gz: 0, files: 0 };
    p.raw += f.raw;
    p.gz += f.gz;
    p.files += 1;
    parts.set(key, p);
    addCandidate(f.path, f.raw, f.gz, where);
  }
  for (const [part, p] of parts) groups.push({ group, part, ...p });
}

const resources = join(unpacked, "resources");
const all = walk(unpacked);

// Electron shell: everything outside resources/.
const shell = all
  .filter((f) => !posix(relative(unpacked, f)).startsWith("resources/"))
  .map((f) => {
    const buf = readFileSync(f);
    return { path: posix(relative(unpacked, f)), raw: buf.length, gz: gzSize(buf) };
  });
summarizeFiles("Electron", shell, firstSegments(1), "Electron");

// app.asar (our code + JS dependencies).
const asarPath = join(resources, "app.asar");
summarizeFiles(
  "app.asar",
  readAsar(asarPath),
  (path) => {
    const m = /^node_modules\/(@[^/]+\/[^/]+|[^/]+)\//.exec(path);
    return m ? `node_modules/${m[1]}` : firstSegments(2)(path);
  },
  "app.asar",
);

// Everything else under resources/: archives are read inside, the rest per folder.
for (const f of all.filter(
  (p) =>
    posix(relative(resources, p)).split("/")[0] !== "app.asar" &&
    posix(relative(unpacked, p)).startsWith("resources/"),
)) {
  const rel = posix(relative(resources, f));
  const size = statSync(f).size;
  if (rel.endsWith(".tar.gz")) {
    const name = `${basename(rel)} (${mb(size)} MB packed)`;
    summarizeFiles(name, readTarGz(f), firstSegments(2), basename(rel));
  } else if (rel.endsWith(".7z.exe")) {
    groups.push({
      group: basename(rel),
      part: "(self-extracting 7z, unpacked at install)",
      raw: size,
      gz: size,
      files: 1,
    });
  } else {
    const buf = readFileSync(f);
    const top = rel
      .split("/")
      .slice(0, rel.startsWith("app.asar.unpacked/node_modules/") ? 3 : 2)
      .join("/");
    groups.push({ group: "resources", part: top, raw: size, gz: gzSize(buf), files: 1 });
    addCandidate(rel, size, gzSize(buf), "resources");
  }
}

// Merge duplicate (group, part) rows from the per-file resources loop.
const merged = new Map();
for (const g of groups) {
  const key = `${g.group}\u0000${g.part}`;
  const m = merged.get(key) ?? { group: g.group, part: g.part, raw: 0, gz: 0, files: 0 };
  m.raw += g.raw;
  m.gz += g.gz;
  m.files += g.files;
  merged.set(key, m);
}
const rows = [...merged.values()].sort((a, b) => b.gz - a.gz);
const byGroup = new Map();
for (const r of rows) {
  const g = byGroup.get(r.group) ?? { group: r.group, raw: 0, gz: 0, files: 0 };
  g.raw += r.raw;
  g.gz += r.gz;
  g.files += r.files;
  byGroup.set(r.group, g);
}
const groupRows = [...byGroup.values()].sort((a, b) => b.gz - a.gz);
const installerSize = installer ? statSync(installer).size : null;

const report = {
  installer: installer ? basename(installer) : null,
  installerMb: installerSize == null ? null : mb(installerSize),
  unpackedMb: mb(all.reduce((s, f) => s + statSync(f).size, 0)),
  groups: groupRows.map((g) => ({ ...g, rawMb: mb(g.raw), gzMb: mb(g.gz) })),
  top: rows.slice(0, 40).map((r) => ({ ...r, rawMb: mb(r.raw), gzMb: mb(r.gz) })),
  candidates: Object.fromEntries(
    Object.entries(candidates).map(([k, c]) => [
      k,
      {
        files: c.files,
        rawMb: mb(c.raw),
        gzMb: mb(c.gz),
        where: Object.fromEntries(Object.entries(c.where).map(([w, b]) => [w, mb(b)])),
      },
    ]),
  ),
};

const md = [
  `Installer ${report.installer ?? "?"}: **${report.installerMb ?? "?"} MB**, unpacked ${report.unpackedMb} MB.`,
  "",
  "| Part | Files | On disk, MB | ≈ in installer, MB |",
  "|---|---|---|---|",
  ...report.groups.map((g) => `| ${g.group} | ${g.files} | ${g.rawMb} | ${g.gzMb} |`),
  "",
  "Largest pieces:",
  "",
  "| Part | Piece | On disk, MB | ≈ in installer, MB |",
  "|---|---|---|---|",
  ...report.top.slice(0, 25).map((r) => `| ${r.group} | ${r.part} | ${r.rawMb} | ${r.gzMb} |`),
  "",
  "Removal candidates (measured only):",
  "",
  "| Candidate | Files | On disk, MB | ≈ in installer, MB | Where |",
  "|---|---|---|---|---|",
  ...Object.entries(report.candidates).map(
    ([k, c]) =>
      `| ${k} | ${c.files} | ${c.rawMb} | ${c.gzMb} | ${Object.entries(c.where)
        .map(([w, v]) => `${w} ${v}`)
        .join(", ")} |`,
  ),
].join("\n");

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "composition.json"), JSON.stringify(report, null, 2));
writeFileSync(join(outDir, "composition.md"), `${md}\n`);
console.log(md);
