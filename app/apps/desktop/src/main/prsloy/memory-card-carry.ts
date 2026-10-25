/**
 * A memory card goes into the chat the person is in when the extractor finishes. Right after «Новый чат»
 * that chat can be replaced by another fresh one before anything is saved, and a card appended to a chat
 * that is never saved is lost with it. Such a card moves to the chat that replaced it, once that chat is
 * the foreground; a card in a chat that got saved stays there.
 */
import { existsSync } from "node:fs";
import { currentSessionFile, onForegroundChanged } from "./session-left.ts";

type Note = (customType: string, text: string, details: Record<string, unknown>) => Promise<void>;
type Card = { customType: string; text: string; details: Record<string, unknown> };

/** How long a moved card waits for the replacing chat's host session before it is appended there. */
export const CARRY_DELAY_MS = 500;
const MAX_PENDING = 3;

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
