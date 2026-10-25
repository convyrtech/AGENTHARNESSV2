/**
 * Minimal zip writer for «Скачать архив» (the built site/) and a guarded reader for the owner's
 * «файл инструментов»: deflate per file, UTF-8 names,
 * no zip64 (a landing page is far below 4 GB). Node's zlib only, no dependency.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

const UTF8_FLAG = 0x0800;

/** Files under `root`, `/`-separated relative paths, sorted; dotfiles and symlinks skipped. */
export function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith(".")) continue;
      const full = join(dir, name);
      const st = statSync(full, { throwIfNoEntry: false });
      if (!st) continue;
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) out.push(relative(root, full).split(sep).join("/"));
    }
  };
  walk(root);
  return out;
}

function dosTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** Zip of every file under `root`, entries prefixed with `prefix/` when given. */
export function zipDirectory(root: string, prefix = ""): Buffer {
  return zipFiles(
    listFiles(root).map((rel) => ({
      name: prefix ? `${prefix}/${rel}` : rel,
      data: readFileSync(join(root, rel)),
      mtime: statSync(join(root, rel)).mtime,
    })),
  );
}

/** Zip of the given entries; `mode` (Unix st_mode) marks the entry as made on Unix. */
export function zipFiles(
  entries: { name: string; data: Buffer; mtime?: Date; mode?: number }[],
): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = e.data;
    const packed = deflateRawSync(data, { level: 9 });
    const stored = packed.length >= data.length;
    const body = stored ? data : packed;
    const name = Buffer.from(e.name, "utf8");
    const crc = crc32(data);
    const { time, date } = dosTime(e.mtime ?? new Date());
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(e.mode === undefined ? 20 : (3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(e.mode === undefined ? 0 : (e.mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

export type ZipEntry = { name: string; data: Buffer };
export type ZipLimits = { files: number; bytes: number; fileBytes: number };

/** Why an archive is refused; `message` is shown to the owner as is. */
export class ZipRefused extends Error {}

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

/** A relative `/` path that cannot leave the folder it is written into, or undefined. */
export function safeEntryName(raw: string): string | undefined {
  if (!raw || raw.includes("\\") || raw.includes("\0") || raw.startsWith("/")) return undefined;
  const parts = raw.split("/").filter((p) => p !== "" && p !== ".");
  // `..` climbs out; `:` is a drive letter or an NTFS stream on Windows
  if (parts.length === 0 || parts.some((p) => p === ".." || p.includes(":"))) return undefined;
  return parts.join("/");
}

/**
 * Files of a zip (stored or deflate), checked before anything touches the disk: no zip64, no
 * encryption, no symlinks, no names that climb out (zip-slip), file count and sizes within
 * `limits`, every entry's CRC. Directory entries are skipped. Sizes come from the central
 * directory, so archives with data descriptors (GitHub's «Download ZIP») read fine.
 */
export function readZip(buf: Buffer, limits: ZipLimits): ZipEntry[] {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0 || eocd + 22 > buf.length) throw new ZipRefused("это не zip-архив");
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff)
    throw new ZipRefused("архив zip64 не поддерживается");
  if (count > limits.files) throw new ZipRefused(`в архиве больше ${limits.files} файлов`);
  if (cdOffset + cdSize > eocd) throw new ZipRefused("архив повреждён");
  const out: ZipEntry[] = [];
  let total = 0;
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50)
      throw new ZipRefused("архив повреждён");
    const madeBy = buf.readUInt16LE(p + 4) >> 8;
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const packed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const attrs = buf.readUInt32LE(p + 38);
    const local = buf.readUInt32LE(p + 42);
    const raw = buf
      .subarray(p + 46, p + 46 + nameLen)
      .toString(flags & UTF8_FLAG ? "utf8" : "latin1");
    p += 46 + nameLen + extraLen + commentLen;
    if (raw.endsWith("/")) continue;
    const name = safeEntryName(raw);
    if (!name) throw new ZipRefused(`путь выходит за папку: ${raw.slice(0, 80)}`);
    if (madeBy === 3 && ((attrs >>> 16) & S_IFMT) === S_IFLNK) {
      throw new ZipRefused(`внутри ссылка, а не файл: ${name.slice(0, 80)}`);
    }
    if (flags & 0x1) throw new ZipRefused("архив зашифрован");
    if (method !== 0 && method !== 8) throw new ZipRefused("неизвестное сжатие");
    if (packed === 0xffffffff || size === 0xffffffff)
      throw new ZipRefused("архив zip64 не поддерживается");
    if (size > limits.fileBytes)
      throw new ZipRefused(`файл больше ${limits.fileBytes >> 20} МБ: ${name}`);
    total += size;
    if (total > limits.bytes)
      throw new ZipRefused(`распакованный архив больше ${limits.bytes >> 20} МБ`);
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50)
      throw new ZipRefused("архив повреждён");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (start + packed > buf.length) throw new ZipRefused("архив повреждён");
    const body = buf.subarray(start, start + packed);
    let data: Buffer;
    try {
      // maxOutputLength: a bomb stops at the size the directory promised
      data =
        method === 0
          ? Buffer.from(body)
          : inflateRawSync(body, { maxOutputLength: Math.max(1, size) });
    } catch {
      throw new ZipRefused(`файл не распаковывается: ${name}`);
    }
    if (data.length !== size || crc32(data) !== crc)
      throw new ZipRefused(`файл повреждён: ${name}`);
    out.push({ name, data });
  }
  return out;
}
