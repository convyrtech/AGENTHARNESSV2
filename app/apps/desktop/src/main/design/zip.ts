/**
 * Minimal zip writer for «Скачать архив» (the built site/): deflate per file, UTF-8 names,
 * no zip64 (a landing page is far below 4 GB). Node's zlib only, no dependency.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

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
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const files = listFiles(root);
  for (const rel of files) {
    const data = readFileSync(join(root, rel));
    const packed = deflateRawSync(data, { level: 9 });
    const stored = packed.length >= data.length;
    const body = stored ? data : packed;
    const name = Buffer.from(prefix ? `${prefix}/${rel}` : rel, "utf8");
    const crc = crc32(data);
    const { time, date } = dosTime(statSync(join(root, rel)).mtime);
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
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
