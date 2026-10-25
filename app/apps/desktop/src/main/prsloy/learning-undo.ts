/**
 * «Откатить ход» is the strongest "that turn was bad" signal for the harness's learning
 * log (STATUS-harness, stage 10 · S0): one line in the same `events.jsonl`, same 5 MB
 * rotation. No paths, no text — the project is a hash of its real path.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { LEARNING_MAX_BYTES, projectKey } from "@prsloy/harness";

export function recordTurnUndo(
  folder: string,
  event: { session?: string | undefined; workspace: string; now?: Date },
): void {
  try {
    const line = {
      kind: "turn.undo",
      ts: (event.now ?? new Date()).toISOString(),
      ...(event.session ? { session: event.session } : {}),
      project: projectKey(event.workspace),
    };
    const text = `${JSON.stringify(line)}\n`;
    mkdirSync(folder, { recursive: true });
    const file = join(folder, "events.jsonl");
    try {
      if (statSync(file).size + Buffer.byteLength(text) > LEARNING_MAX_BYTES) {
        renameSync(file, `${file}.1`);
      }
    } catch {
      // no log yet
    }
    appendFileSync(file, text);
  } catch (error) {
    console.warn("[prsloy] learning log (turn.undo) failed:", error);
  }
}
