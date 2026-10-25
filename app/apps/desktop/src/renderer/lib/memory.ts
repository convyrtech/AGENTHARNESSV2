/**
 * «Память» in the app (research/18 §6.7, STATUS-harness S4 contract): the harness's memory
 * cards in the chat and the settings panel. Main's `prsloy:memory-*` (core) does the
 * reading and forgetting; here only what the renderer decides.
 */
import type {
  MemoryConfirmCardDetails,
  MemoryApi,
  MemoryAutoCardDetails,
  MemoryItem,
  MemorySnapshot,
  MemoryUpdatedCardDetails,
} from "@zeno/contracts";

export type MemoryCardKind =
  | "saved"
  | "forgot"
  | "full"
  | "refused"
  | "auto"
  | "updated"
  | "confirm";

const CARD_TYPES: Record<string, MemoryCardKind> = {
  "prsloy-memory.saved": "saved",
  "prsloy-memory.forgot": "forgot",
  "prsloy-memory.full": "full",
  "prsloy-memory.refused": "refused",
  // Memory v2 (research/24 §3.6): written by the harness itself, from the owner's words.
  "prsloy-memory.auto": "auto",
  "prsloy-memory.updated": "updated",
  // research/27 §2: the agent's tool asks before it forgets or replaces (core, #14).
  "prsloy-memory.confirm": "confirm",
};

export function memoryCardKind(customType: string | undefined): MemoryCardKind | undefined {
  return customType ? CARD_TYPES[customType] : undefined;
}

/** The entry the card is about: `details.id` of a live card. */
export function memoryCardId(details: unknown): string | undefined {
  const id = (details as { id?: unknown } | null | undefined)?.id;
  return typeof id === "string" && id ? id : undefined;
}

/**
 * The remembered text in a «Запомнил «…»» card (the harness writes it in Russian). The older «Запомнил: …»
 * is still parsed: alpha.1 chats keep those cards.
 */
export function savedCardText(text: string): string {
  const quoted = /^Запомнил(?: для этого проекта)? «([\s\S]*)»$/u.exec(text.trim());
  if (quoted) return quoted[1]!.trim();
  return text.replace(/^Запомнил(?: для этого проекта)?:\s*/u, "").trim();
}

/** A project card, in either format. */
export function isProjectCardText(text: string): boolean {
  return /^Запомнил для этого проекта[:\s]/u.test(text);
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

function str(value: unknown, max = 400): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function scopeOf(value: unknown): "user" | "project" {
  return value === "project" ? "project" : "user";
}

/** `prsloy-memory.auto` details; entries without an id or text are dropped. */
export function parseAutoDetails(details: unknown): MemoryAutoCardDetails["items"] {
  const items = (details as { items?: unknown } | null | undefined)?.items;
  if (!Array.isArray(items)) return [];
  return items.flatMap((raw) => {
    const item = raw as Record<string, unknown> | null;
    const id = str(item?.id, 80);
    const text = str(item?.text);
    if (!id || !text) return [];
    const quote = str(item?.quote);
    return [{ id, scope: scopeOf(item?.scope), text, ...(quote ? { quote } : {}) }];
  });
}

/** `prsloy-memory.updated` details, or undefined when something needed is missing. */
export function parseUpdatedDetails(details: unknown): MemoryUpdatedCardDetails | undefined {
  const d = details as Record<string, unknown> | null | undefined;
  const opId = str(d?.opId, 80);
  const before = str(d?.before);
  const after = str(d?.after);
  if (!opId || !before || !after) return undefined;
  return {
    opId,
    id: str(d?.id, 80),
    scope: scopeOf(d?.scope),
    before,
    after,
    ...(d?.pinned === true ? { pinned: true } : {}),
  };
}

/** `prsloy-memory.confirm` details: forget needs the text, replace needs before and after. */
export function parseConfirmDetails(details: unknown): MemoryConfirmCardDetails | undefined {
  const d = details as Record<string, unknown> | null | undefined;
  const confirmId = str(d?.confirmId, 80);
  const id = str(d?.id, 80);
  if (!confirmId || !id) return undefined;
  const base = { confirmId, id, scope: scopeOf(d?.scope) };
  if (d?.action === "forget") {
    const text = str(d?.text);
    return text ? { ...base, action: "forget", text } : undefined;
  }
  if (d?.action === "replace") {
    const before = str(d?.before);
    const after = str(d?.after);
    return before && after ? { ...base, action: "replace", before, after } : undefined;
  }
  return undefined;
}

/** A date for the panel: «25 окт.», with the year when it is not this year. */
export function memoryDate(locale: string, iso: string | undefined, now = new Date()): string {
  const at = iso ? new Date(iso) : undefined;
  if (!at || Number.isNaN(at.getTime())) return "";
  return at.toLocaleDateString(locale, {
    day: "numeric",
    month: "short",
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

const AUTO_INTRO_KEY = "prsloy.memory.autoIntroSeen";

/** «Замечать важное само» says once how it works, the first time it goes on (research/24 §3.6). */
export function autoIntroSeen(): boolean {
  try {
    return localStorage.getItem(AUTO_INTRO_KEY) === "1";
  } catch {
    return true;
  }
}

export function markAutoIntroSeen(): void {
  try {
    localStorage.setItem(AUTO_INTRO_KEY, "1");
  } catch {
    // no storage: the card shows again next time
  }
}

/** Entries in `before` that are gone from `after` — what «Забыть всё из этого чата» took away. */
export function forgottenBetween(before: MemorySnapshot, after: MemorySnapshot): MemoryItem[] {
  const kept = new Set([...after.user, ...after.project].map((item) => item.id));
  return [...before.user, ...before.project].filter((item) => !kept.has(item.id));
}
