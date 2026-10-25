/**
 * Reading another tool's SQLite database without touching it (research/25 §4.2): the database
 * and its `-wal` / `-shm` companions are copied into a temp folder and the copy is opened with
 * `node:sqlite`, read-only. The tool may be running and writing — its WAL holds the newest rows,
 * so the WAL is copied too. The copy lives for one scan or run and is removed by dispose().
 *
 * Approach adapted from cline/cline (Apache-2.0, © 2026 Cline Bot Inc.),
 * sdk/packages/core/src/services/session-import/opencode.ts @ 40c5d99 (snapshot with WAL, kept for
 * the batch). Changed by PRSLOY: node:sqlite, read-only, schema check helper.
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Snapshot = {
  db: DatabaseSync;
  /** Table names in the database, for the schema check. */
  tables: Set<string>;
  dispose(): void;
};

export function openSnapshot(dbPath: string): Snapshot {
  const dir = mkdtempSync(join(tmpdir(), "prsloy-sqlite-"));
  let db: DatabaseSync | undefined;
  try {
    const copy = join(dir, basename(dbPath));
    copyFileSync(dbPath, copy);
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(`${dbPath}${suffix}`)) copyFileSync(`${dbPath}${suffix}`, `${copy}${suffix}`);
    }
    db = new DatabaseSync(copy, { readOnly: true });
    const tables = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: string;
        }[]
      ).map((row) => row.name),
    );
    const opened = db;
    return {
      db: opened,
      tables,
      dispose() {
        try {
          opened.close();
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    try {
      db?.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    throw error;
  }
}

/** The columns a table has, for checking a schema before reading it. */
export function columnsOf(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info("${table.replaceAll('"', '""')}")`).all() as {
    name: string;
  }[];
  return new Set(rows.map((row) => row.name));
}
