/**
 * «Память» in the app (research/18 §6.7, STATUS-harness S4 contract): the harness's memory
 * cards in the chat and the settings panel. Main's `prsloy:memory-*` (core) does the
 * reading and forgetting; here only what the renderer decides.
 */
import type { MemoryApi, MemorySnapshot } from "@zeno/contracts";

export type MemoryCardKind = "saved" | "forgot" | "full" | "refused";

const CARD_TYPES: Record<string, MemoryCardKind> = {
  "prsloy-memory.saved": "saved",
  "prsloy-memory.forgot": "forgot",
  "prsloy-memory.full": "full",
  "prsloy-memory.refused": "refused",
};

export function memoryCardKind(customType: string | undefined): MemoryCardKind | undefined {
  return customType ? CARD_TYPES[customType] : undefined;
}

/** The entry the card is about: `details.id` of a live card. */
export function memoryCardId(details: unknown): string | undefined {
  const id = (details as { id?: unknown } | null | undefined)?.id;
  return typeof id === "string" && id ? id : undefined;
}

/** The remembered text in a «Запомнил: …» card (the harness writes it in Russian). */
export function savedCardText(text: string): string {
  return text.replace(/^Запомнил(?: для этого проекта)?:\s*/u, "").trim();
}

/**
 * A card from history has no `details`: find its entry by text in the snapshot.
 * Undefined when it is gone (already forgotten) or never matched.
 */
export function findEntryId(snapshot: MemorySnapshot, text: string): string | undefined {
  const wanted = text.trim();
  return [...snapshot.user, ...snapshot.project].find((entry) => entry.text.trim() === wanted)?.id;
}

/** «Забыл.» keeps «Вернуть» for 10 s after the card appeared (§6.7). */
export const RESTORE_WINDOW_MS = 10_000;

export function restoreLeftMs(timestamp: string | undefined, now: number): number {
  const at = timestamp ? Date.parse(timestamp) : Number.NaN;
  if (Number.isNaN(at)) return 0;
  return Math.max(0, at + RESTORE_WINDOW_MS - now);
}

/** Main serves memory only once core's IPC is in; until then the panel says so. */
export function memoryApi(): MemoryApi | undefined {
  return typeof window !== "undefined" ? window.zeno?.memory : undefined;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const HINT_KEY = "prsloy.memory.hintSeen";

/** The first «Запомнил» card says once how memory works (research/18 §6.7). */
export function memoryHintSeen(): boolean {
  try {
    return localStorage.getItem(HINT_KEY) === "1";
  } catch {
    return true;
  }
}

export function markMemoryHintSeen(): void {
  try {
    localStorage.setItem(HINT_KEY, "1");
  } catch {
    // no storage: the hint just shows again next time
  }
}
