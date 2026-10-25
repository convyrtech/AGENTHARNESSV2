/**
 * Agent Host crash → automatic restart on the same session, unless it keeps crashing.
 * Pure policy; the supervisor in index.ts owns the timer and the actual start().
 */
export const CRASH_RESTART_DELAY_MS = 1_500;
export const CRASH_RESTART_WINDOW_MS = 60_000;
export const CRASH_RESTART_MAX = 3;

/**
 * Returns the updated restart history, or undefined when another restart is not allowed
 * (crash loop: leave it to the user's «Новый разговор» instead of spinning).
 */
export function nextCrashRestart(
  history: readonly number[],
  now: number,
  env: NodeJS.ProcessEnv = process.env,
): number[] | undefined {
  if (env.PRSLOY_NO_AUTO_RESTART === "1") return undefined;
  const recent = history.filter((at) => now - at < CRASH_RESTART_WINDOW_MS);
  if (recent.length >= CRASH_RESTART_MAX) return undefined;
  return [...recent, now];
}
