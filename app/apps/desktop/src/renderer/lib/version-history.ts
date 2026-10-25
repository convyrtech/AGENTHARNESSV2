/**
 * «История версий» (research 19 §1.8): the snapshots core takes before every prompt in this
 * project, as a list the owner can go back to. Pure: no IPC, no clock of its own.
 */
import type { PrsloyTurnSnapshot } from "@zeno/contracts";
import { localeTag, t, type Locale } from "./i18n.ts";

export const HISTORY_LIMIT = 50;

/** Newest first, at most `HISTORY_LIMIT`; undo backups stay, they are versions too. */
export function historyEntries(snapshots: readonly PrsloyTurnSnapshot[]): PrsloyTurnSnapshot[] {
  return [...snapshots]
    .filter((s) => !Number.isNaN(Date.parse(s.createdAt)))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, HISTORY_LIMIT);
}

/** What the version was taken before: the request, or «Перед откатом». */
export function historyWhat(locale: Locale, snapshot: PrsloyTurnSnapshot): string {
  if (snapshot.kind === "undo-backup") return t(locale, "features.history.beforeUndo");
  return snapshot.prompt?.trim() || t(locale, "features.history.noText");
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** «сегодня 10:05», «вчера 18:40», else «12 окт., 09:30». */
export function historyTime(locale: Locale, iso: string, now: Date): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString(localeTag(locale), { hour: "2-digit", minute: "2-digit" });
  if (sameDay(at, now)) return t(locale, "features.history.today", { time });
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(at, yesterday)) return t(locale, "features.history.yesterday", { time });
  const day = at.toLocaleDateString(localeTag(locale), { day: "numeric", month: "short" });
  return `${day}, ${time}`;
}
