/**
 * What happened to each «Откатить»: kept so the transcript marker («Ход откачен: вернул
 * 3 файла») survives a remount, a chat switch and a restart. Keyed by core's snapshot id.
 * localStorage, bounded; a missing or broken store just means no marker.
 */

export type UndoOutcome =
  | { kind: "undone"; count: number; backupId?: string | undefined }
  | { kind: "restored"; count: number };

const KEY = "prsloy.undo.log.v1";
/** Fired after a save: the undo note core appends re-renders the timeline mid-undo, so the
 * action that saves may already be unmounted and its replacement must pick the result up. */
export const UNDO_LOG_CHANGED_EVENT = "prsloy-undo-log";
const MAX_ENTRIES = 200;

function readLog(): Record<string, UndoOutcome> {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, UndoOutcome>)
      : {};
  } catch {
    return {};
  }
}

function isOutcome(value: unknown): value is UndoOutcome {
  if (!value || typeof value !== "object") return false;
  const v = value as { kind?: unknown; count?: unknown };
  return (v.kind === "undone" || v.kind === "restored") && typeof v.count === "number";
}

export function loadUndoOutcome(snapshotId: string): UndoOutcome | undefined {
  const entry = readLog()[snapshotId];
  return isOutcome(entry) ? entry : undefined;
}

export function saveUndoOutcome(snapshotId: string, outcome: UndoOutcome): void {
  const log = readLog();
  delete log[snapshotId];
  log[snapshotId] = outcome;
  const ids = Object.keys(log);
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX_ENTRIES))) delete log[id];
  try {
    localStorage.setItem(KEY, JSON.stringify(log));
  } catch {
    // Storage unavailable: the marker lives until the next remount.
  }
  try {
    window.dispatchEvent(new CustomEvent(UNDO_LOG_CHANGED_EVENT, { detail: snapshotId }));
  } catch {
    // No window in node tests.
  }
}
