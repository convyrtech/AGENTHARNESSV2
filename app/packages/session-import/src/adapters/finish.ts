/**
 * The common end of every adapter: merge replies with no request between them, keep the newest
 * 300 turns, hide secrets in the turns and the title, take the times from the turns.
 */
import { cleanText } from "../clean.ts";
import { pickTitle } from "../title.ts";
import type { DroppedCounts, ImportedChat, ImportedTurn, ImportTool } from "../types.ts";
import { MAX_TURNS } from "./claude-code.ts";

/** Adds a turn, joining it to the previous reply when both are the agent's. */
export function pushTurn(
  turns: ImportedTurn[],
  role: ImportedTurn["role"],
  text: string,
  ts?: number,
) {
  const trimmed = text.trim();
  if (!trimmed) return;
  const last = turns.at(-1);
  if (role === "assistant" && last?.role === "assistant") {
    last.text = `${last.text}\n${trimmed}`;
    return;
  }
  turns.push({
    role,
    text: trimmed,
    ...(ts !== undefined && Number.isFinite(ts) ? { timestamp: ts } : {}),
  });
}

export function finishChat(input: {
  tool: ImportTool;
  sourceId: string;
  sourcePath: string;
  cwd: string;
  turns: ImportedTurn[];
  titles: { customTitle?: string | undefined; aiTitle?: string | undefined };
  model?: string | undefined;
  files: Iterable<string>;
  dropped: DroppedCounts;
  fallbackTime: number;
}): ImportedChat | undefined {
  if (!input.turns.some((t) => t.role === "user")) return undefined;
  let secrets = 0;
  const kept = input.turns.slice(-MAX_TURNS).map((turn) => {
    const cleaned = cleanText(turn.text);
    secrets += cleaned.secrets;
    return { ...turn, text: cleaned.text };
  });
  const firstRequest = input.turns.find((t) => t.role === "user")?.text;
  const title = cleanText(pickTitle({ ...input.titles, firstRequest }));
  secrets += title.secrets;
  const times = kept.map((t) => t.timestamp).filter((t): t is number => t !== undefined);
  return {
    tool: input.tool,
    sourceId: input.sourceId,
    sourcePath: input.sourcePath,
    cwd: input.cwd,
    title: title.text,
    startedAt: times[0] ?? input.fallbackTime,
    updatedAt: times.at(-1) ?? input.fallbackTime,
    ...(input.model ? { model: input.model } : {}),
    turns: kept.filter((t) => t.text),
    files: [...input.files].slice(0, 50),
    dropped: input.dropped,
    secrets,
  };
}
