// Счётчики вмешательств харнесса по сессиям — для замера (scripts/bench.mts) в том же процессе. В чат и в
// сессию ничего не пишется: запись custom приложение показало бы сырым JSON.
const bySession = new Map<string, Record<string, number>>();

export function bumpStat(session: string, kind: string, by = 1): void {
  const stats = bySession.get(session) ?? {};
  stats[kind] = (stats[kind] ?? 0) + by;
  bySession.set(session, stats);
}

/** Счётчики сессии (копия). */
export function harnessStats(session: string): Record<string, number> {
  return { ...bySession.get(session) };
}
