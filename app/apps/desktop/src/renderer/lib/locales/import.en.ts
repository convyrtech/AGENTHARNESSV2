/**
 * Chats from other agents (#22 I1): first-run step and settings, en.
 */
import type { importZh } from "./import.zh.ts";

export const importEn: Record<keyof typeof importZh, string> = {
  "prsloy.import.scanning": "Looking for chats from other apps…",
  "prsloy.import.title": "Bring over chats from other apps?",
  "prsloy.import.lead":
    "Found conversations with other assistants on this computer. Bring them here to pick up where you left off.",
  "prsloy.import.note": "Chats from the last 30 days, at most 50. Your files stay as they are.",
  "prsloy.import.chats.one": "{count} chat",
  "prsloy.import.chats.few": "{count} chats",
  "prsloy.import.chats.many": "{count} chats",
  "prsloy.import.projects.one": " in {count} project",
  "prsloy.import.projects.few": " in {count} projects",
  "prsloy.import.projects.many": " in {count} projects",
  "prsloy.import.submit": "Bring over",
  "prsloy.import.later": "Not now",
  "prsloy.import.running": "Bringing over… {done} of {total}",
  "prsloy.import.imported.one": "Brought over {count} chat",
  "prsloy.import.imported.few": "Brought over {count} chats",
  "prsloy.import.imported.many": "Brought over {count} chats",
  "prsloy.import.skipped":
    "Not brought over: {count} (the project folder is gone or the chat is empty)",
  "prsloy.import.next": "Continue",
  "prsloy.import.failed": "Could not bring the chats over: {message}",
  "prsloy.import.nothing": "No chats from other apps found.",
  "prsloy.import.settingsTitle": "Chats from other apps",
  "prsloy.import.settingsHint":
    "Bring conversations from Claude Code, Codex and others here to continue them.",
  "prsloy.import.unreadable": "Could not read chats from {tools} (an unfamiliar format).",
  "prsloy.import.find": "Find chats",
};
