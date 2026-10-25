/**
 * «Откатить ход»: which finished turns changed files, and which snapshot each one restores.
 *
 * Main snapshots the workspace before every prompt (`window.zeno.prsloy.listTurns`), keyed
 * by the prompt's first line and time, and only sometimes by session id (a new chat's first
 * turn is snapshotted before the session exists). So a timeline turn is matched to its
 * snapshot by prompt preview, newest first, never reusing a snapshot.
 */
import type { PrsloyTurnSnapshot, PrsloyUndoResult } from "@zeno/contracts";
import { classifyToolName } from "./process-activity.ts";
import { localeTag, type Locale, type MessageKey } from "./i18n.ts";
import type { TimelineBlock } from "./timeline.ts";

export type TimelineTurn = {
  userId: string;
  userText: string;
  userTimestamp?: string | undefined;
  /** Index of the turn's last block: the undo action renders right after it. */
  lastBlockIndex: number;
  /** An edit or write tool ran in this turn. */
  changedFiles: boolean;
};

/** Same rule as main's snapshot `prompt`: first line, at most 120 characters. */
export function promptPreview(message: string): string {
  const line = message.trim().split(/\r?\n/u)[0] ?? "";
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

/** Finished turns in timeline order. The trailing turn is left out while the agent runs. */
export function timelineTurns(blocks: readonly TimelineBlock[], running: boolean): TimelineTurn[] {
  const turns: TimelineTurn[] = [];
  let current: TimelineTurn | undefined;
  blocks.forEach((block, index) => {
    if (block.type === "item" && block.item.kind === "user") {
      if (current) turns.push(current);
      current = {
        userId: block.item.id,
        userText: block.item.text,
        userTimestamp: block.item.timestamp,
        lastBlockIndex: index,
        changedFiles: false,
      };
      return;
    }
    if (!current) return;
    current.lastBlockIndex = index;
    const tools = block.type === "process" ? block.items : [block.item];
    for (const item of tools) {
      if (item.kind !== "tool" || item.status === "running") continue;
      const kind = classifyToolName(item.toolName);
      if (kind === "edit" || kind === "write") current.changedFiles = true;
    }
  });
  if (current && !running) turns.push(current);
  return turns;
}

/** Allowed clock skew between the snapshot (taken before the prompt) and the user message. */
const SNAPSHOT_SLACK_MS = 60_000;

/** userId → snapshot id for every turn that has one. */
export function matchTurnSnapshots(
  turns: readonly TimelineTurn[],
  snapshots: readonly PrsloyTurnSnapshot[],
  sessionId?: string,
): Map<string, string> {
  const pool = snapshots
    .filter((s) => s.kind === "turn" && (!sessionId || !s.sessionId || s.sessionId === sessionId))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const used = new Set<string>();
  const matched = new Map<string, string>();
  for (const turn of [...turns].reverse()) {
    const preview = promptPreview(turn.userText);
    const at = turn.userTimestamp ? Date.parse(turn.userTimestamp) : Number.NaN;
    const hit = pool.find(
      (s) =>
        !used.has(s.id) &&
        s.prompt === preview &&
        (Number.isNaN(at) || Date.parse(s.createdAt) <= at + SNAPSHOT_SLACK_MS),
    );
    if (!hit) continue;
    used.add(hit.id);
    matched.set(turn.userId, hit.id);
  }
  return matched;
}

/** Distinct files an undo touched (rewritten or removed). */
export function undoneFileCount(result: Pick<PrsloyUndoResult, "rewritten" | "removed">): number {
  return new Set([...result.rewritten, ...result.removed]).size;
}

/** «Вернул 1 файл / 3 файла / 5 файлов», or «Файлы не менялись» for zero. */
export function undoResultKey(locale: Locale, count: number): MessageKey {
  if (count <= 0) return "prsloy.undo.result.none";
  const form = new Intl.PluralRules(localeTag(locale)).select(count);
  if (form === "one") return "prsloy.undo.result.one";
  if (form === "few") return "prsloy.undo.result.few";
  return "prsloy.undo.result.many";
}
