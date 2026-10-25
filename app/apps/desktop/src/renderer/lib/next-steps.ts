/**
 * «Что дальше» (research 19 §1.7): 2–3 buttons after a finished turn with the next request
 * the owner could make. The model may end its reply with
 *
 *   <prsloy-next>
 *   Добавь форму заявки
 *   Сделай версию для телефона
 *   </prsloy-next>
 *
 * and the tag never shows in the reply. Without the tag, the buttons come from what the
 * turn wrote (a page, a bot, other code) — no extra model call.
 *
 * Tag rules adapted from Dyad `src/lib/suggestedPrompts.ts` (commit 1be2b4b), Apache-2.0,
 * Copyright (c) Dyad contributors; see app/licenses/dyad-Apache-2.0.txt.
 * Changed by PRSLOY: own tag, a regex instead of Dyad's stream parser, a fallback from the
 * turn's files, Russian-first texts.
 */
import { t, type Locale, type MessageKey } from "./i18n.ts";
import type { TimelineItem } from "./timeline.ts";
import { isTurnStatusItem } from "./turn-status.ts";

export const NEXT_TAG = "prsloy-next";
export const MAX_NEXT_STEPS = 3;
/** A button shows one line but sends its whole text: longer ones are dropped, not sent unread. */
export const MAX_NEXT_STEP_CHARS = 120;

const CLOSED = new RegExp(`<${NEXT_TAG}>([\\s\\S]*?)</${NEXT_TAG}>`, "giu");
const OPEN_TAIL = new RegExp(`<${NEXT_TAG}>[\\s\\S]*$`, "iu");

/** The reply as the owner reads it: closed tags removed, a still-streaming one cut off. */
export function withoutNextTag(text: string): string {
  if (!text.toLowerCase().includes(`<${NEXT_TAG}>`)) return text;
  return text.replace(CLOSED, "").replace(OPEN_TAIL, "").trimEnd();
}

/**
 * Steps from the last closed tag, only when nothing but whitespace follows it (text after
 * means the reply did not end with them). List marks are dropped, duplicates and overlong
 * lines skipped, at most three.
 */
export function extractNextSteps(text: string): string[] {
  const matches = [...text.matchAll(CLOSED)];
  const last = matches.at(-1);
  if (!last || last.index === undefined) return [];
  if (text.slice(last.index + last[0].length).trim()) return [];
  const seen = new Set<string>();
  const steps: string[] = [];
  for (const raw of (last[1] ?? "").split(/\r?\n/u)) {
    const step = raw
      .trim()
      .replace(/^(?:[-*•]|\d+[.)])\s+/u, "")
      .trim();
    if (!step || step.length > MAX_NEXT_STEP_CHARS) continue;
    const key = step.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    steps.push(step);
    if (steps.length >= MAX_NEXT_STEPS) break;
  }
  return steps;
}

type Tool = Extract<TimelineItem, { kind: "tool" }>;

function writtenFiles(tools: readonly Tool[]): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = [];
  for (const tool of tools) {
    if (tool.status !== "completed" || !/^(write|edit|multi_?edit)$/iu.test(tool.toolName))
      continue;
    const args = (tool.args ?? {}) as { path?: unknown; content?: unknown; newText?: unknown };
    if (typeof args.path !== "string") continue;
    const content =
      typeof args.content === "string"
        ? args.content
        : typeof args.newText === "string"
          ? args.newText
          : "";
    out.push({ path: args.path, content });
  }
  return out;
}

const SITE: MessageKey[] = [
  "features.next.site.phone",
  "features.next.site.form",
  "features.next.site.bright",
];
const BOT: MessageKey[] = [
  "features.next.bot.help",
  "features.next.bot.buttons",
  "features.next.bot.run",
];
const CODE: MessageKey[] = ["features.next.code.check", "features.next.code.explain"];

/** Steps from what the turn wrote: a page, a Telegram bot, other code; nothing if no files. */
export function fallbackNextSteps(locale: Locale, tools: readonly Tool[]): string[] {
  const files = writtenFiles(tools);
  if (files.length === 0) return [];
  const bot = files.some(
    (f) => /\.(py|js|ts)$/iu.test(f.path) && /telegram|aiogram|telebot|grammy/iu.test(f.content),
  );
  const site = files.some((f) => /\.html?$/iu.test(f.path));
  const keys = bot ? BOT : site ? SITE : CODE;
  return keys.map((key) => t(locale, key));
}

/**
 * The buttons for the chat: only after the last turn, only when it finished cleanly (its
 * last item is the reply, no error in it), never while the agent works.
 */
export function selectNextSteps(
  locale: Locale,
  items: readonly TimelineItem[],
  running: boolean,
): string[] {
  if (running) return [];
  const start = items.findLastIndex((item) => item.kind === "user");
  if (start < 0) return [];
  // The harness's turn-status card (H9) comes after the reply: it is not the end of the reply.
  const turn = items.slice(start + 1).filter((item) => !isTurnStatusItem(item));
  // Other notes after the reply (the undo note main appends for the model) are not the turn's end
  // either: «Откатить ход» used to take «Что дальше» away with it.
  const last = turn.filter((item) => item.kind !== "system").at(-1);
  if (!last || last.kind !== "assistant" || !last.text.trim()) return [];
  if (turn.some((item) => item.kind === "system" && item.tone === "error")) return [];
  const fromModel = extractNextSteps(last.text);
  if (fromModel.length > 0) return fromModel;
  return fallbackNextSteps(
    locale,
    turn.filter((item): item is Tool => item.kind === "tool"),
  );
}
