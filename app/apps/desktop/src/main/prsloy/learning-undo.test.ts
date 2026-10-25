import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { LEARNING_MAX_BYTES } from "@prsloy/harness";
import { recordTurnUndo } from "./learning-undo.ts";

const dir = mkdtempSync(join(tmpdir(), "prsloy-undo-log-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("turn.undo in the learning log", () => {
  it("rotates like the harness log: a full file moves to .1", () => {
    const file = join(dir, "events.jsonl");
    writeFileSync(file, "x".repeat(LEARNING_MAX_BYTES - 10));
    recordTurnUndo(dir, { session: "s", workspace: dir, now: new Date(0) });
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
      kind: "turn.undo",
      ts: "1970-01-01T00:00:00.000Z",
      session: "s",
    });
  });
});
