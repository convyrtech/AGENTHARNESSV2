/**
 * A memory card goes into the chat the person is in when the extractor finishes. Right after «Новый чат»
 * that chat can be replaced by another fresh one before anything is saved, and a card appended to a chat
 * that is never saved is lost with it. Such a card moves to the chat that replaced it, once that chat is
 * the foreground; a card in a chat that got saved stays there.
 *
 * A card never moves to another project (#73). Chats are filed per project
 * (`sessions/<cwd-slug>/<file>.jsonl`, plain conversations right in `sessions/`), so the folder of the
 * session file names the project: a switch into a chat from a different folder drops the card instead of
 * showing it in a project the entry does not belong to. The entry itself is already in the memory of its
 * own project, so only the confirmation card is lost.
 */
import { existsSync } from "node:fs";
import { currentSessionFile, onForegroundChanged } from "./session-left.ts";

type Note = (customType: string, text: string, details: Record<string, unknown>) => Promise<void>;
type Card = { customType: string; text: string; details: Record<string, unknown> };

/** How long a moved card waits for the replacing chat's host session before it is appended there. */
export const CARRY_DELAY_MS = 500;
const MAX_PENDING = 3;

/** The project a chat file belongs to: its folder (pi files chats per cwd slug). */
export function projectOf(sessionFile: string): string {
  const unified = sessionFile.replace(/\\/gu, "/").replace(/\/+$/u, "");
  const cut = unified.lastIndexOf("/");
  return (cut > 0 ? unified.slice(0, cut) : "").toLowerCase();
}

/** Scopes of the entries a card announces (a card about the person is worth showing anywhere). */
function cardScopes(details: Record<string, unknown>): string[] {
  const items = Array.isArray(details.items) ? details.items : [];
  const scopes = [details.scope, ...items.map((item) => (item as { scope?: unknown })?.scope)];
  return scopes.filter((scope): scope is string => typeof scope === "string");
}

/**
 * A card about one project is shown only in a chat of that project (#73). The extractor finishes a few
 * seconds after the person left, and by then another project's chat may be the foreground: the card would
 * name an entry that is not in that project's memory. A card that says something about the person is kept
 * everywhere. Dropped cards are simply not shown — the entry stays in the memory of its own project.
 */
export function onlyInProjectOf(sessionFile: string, note: Note): Note {
  return async (customType, text, details) => {
    const scopes = cardScopes(details);
    if (scopes.length && scopes.every((scope) => scope === "user")) {
      return note(customType, text, details);
    }
    const now = currentSessionFile();
    if (now && projectOf(now) !== projectOf(sessionFile)) {
      console.warn(`[prsloy] memory card of another project is not shown: ${sessionFile} → ${now}`);
      return;
    }
    return note(customType, text, details);
  };
}

export function carryUnsavedCards(
  deliver: Note,
  options: { exists?: (file: string) => boolean; delayMs?: number } = {},
): { note: Note; stop(): void } {
  const exists = options.exists ?? existsSync;
  const delayMs = options.delayMs ?? CARRY_DELAY_MS;
  let pending: { file: string; card: Card }[] = [];
  const stop = onForegroundChanged((from, to) => {
    const moving = pending.filter((p) => p.file === from && !exists(from));
    pending = pending.filter((p) => p.file !== from);
    // Another project: the card is not carried, nowhere to show it without lying.
    if (projectOf(from) !== projectOf(to)) {
      if (moving.length) {
        console.warn(
          `[prsloy] memory card not carried to another project (${moving.length}): ${from} → ${to}`,
        );
      }
      return;
    }
    for (const p of moving) {
      pending.push({ file: to, card: p.card });
      const timer = setTimeout(() => {
        // Moved on again meanwhile: the next change carries it further.
        if (currentSessionFile() !== to) return;
        void deliver(p.card.customType, p.card.text, p.card.details).catch((error) =>
          console.warn("[prsloy] memory card not delivered:", error),
        );
      }, delayMs);
      timer.unref?.();
    }
  });
  return {
    note: async (customType, text, details) => {
      await deliver(customType, text, details);
      const file = currentSessionFile();
      if (file && !exists(file)) {
        pending.push({ file, card: { customType, text, details } });
        pending = pending.slice(-MAX_PENDING);
      }
    },
    stop,
  };
}
