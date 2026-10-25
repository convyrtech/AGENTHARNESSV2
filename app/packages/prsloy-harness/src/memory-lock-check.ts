// Проверка записи памяти несколькими процессами сразу (M-sp, research/24 §3.1): общая для unit-теста и
// Windows smoke. Каждый процесс добавляет свои записи; потом в файле должны быть все, журнал — по строке на запись.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryStore } from "./memory-store.ts";

const WRITER = fileURLToPath(new URL("../test/fixtures/memory-writer.mts", import.meta.url));
/** Разные по основам записи: дублями друг друга они не станут. */
const WORDS = "кошек собак горы море кофе джаз футбол шахматы театр весну лыжи грибы".split(" ");

export async function concurrentMemoryWrites(options: {
  dir: string;
  cwd: string;
  processes?: number;
  node?: string;
}): Promise<{ expected: number; entries: number; remembered: number; failures: string[] }> {
  const processes = options.processes ?? 4;
  const per = Math.floor(WORDS.length / processes);
  const failures: string[] = [];
  await Promise.all(
    Array.from({ length: processes }, (_, p) => {
      const texts = WORDS.slice(p * per, (p + 1) * per).map((w) => `Люблю ${w}`);
      return new Promise<void>((resolve) => {
        const child = spawn(
          options.node ?? process.execPath,
          [WRITER, options.dir, options.cwd, ...texts],
          {
            stdio: ["ignore", "ignore", "pipe"],
          },
        );
        let err = "";
        child.stderr.on("data", (d: Buffer) => (err += d.toString()));
        child.on("exit", (code) => {
          if (code !== 0) failures.push(`writer ${p} exited ${code}: ${err.trim()}`);
          resolve();
        });
      });
    }),
  );
  const store = new MemoryStore(options.dir);
  const journal = readFileSync(join(options.dir, "journal.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.includes('"op":"remember"')).length;
  return {
    expected: per * processes,
    entries: store.entries("user", options.cwd).length,
    remembered: journal,
    failures,
  };
}
