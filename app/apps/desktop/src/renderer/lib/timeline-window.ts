/**
 * Long chats render only their tail: opening a 500-turn chat used to build every block
 * (one ~1.7 s main-thread task). Older blocks come in steps when the reader scrolls up
 * (or jumps there from the minimap).
 */
export const TIMELINE_INITIAL_BLOCKS = 200;
export const TIMELINE_STEP_BLOCKS = 200;

/** Index of the first block to render. */
export function timelineWindowStart(blockCount: number, limit: number): number {
  if (!Number.isFinite(limit)) return 0;
  return Math.max(0, blockCount - Math.max(1, Math.floor(limit)));
}

export function nextTimelineLimit(limit: number): number {
  return Number.isFinite(limit) ? limit + TIMELINE_STEP_BLOCKS : limit;
}
