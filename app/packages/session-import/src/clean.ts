/**
 * Making other agents' text safe to carry over (research/25 §4.2 `clean.ts`, §5): the service
 * wrappers those agents put around a person's words come off, invisible and Unicode-tag
 * characters go (a hidden-instruction channel), secrets are hidden, very long texts are cut.
 * Tool calls become one short line each («• Bash: npm test»); a failed tool keeps 300 characters.
 *
 * Portions adapted from openai/codex (Apache-2.0, © 2025 OpenAI),
 * codex-rs/external-agent-migration/src/sessions/title.rs and records_common.rs @ 970111f
 * (the list of control wrappers, note limits), and from cline/cline (Apache-2.0, © 2026 Cline
 * Bot Inc.), sdk/packages/core/src/services/session-import/codex.ts @ 40c5d99 (the injected-context
 * prefixes). Changed by PRSLOY: wrappers are cut anywhere in the text, not only at its start;
 * notes are one plain line in the reply instead of tagged blocks.
 */
import { INVISIBLE_FOR_PEOPLE, scrubSecrets } from "@prsloy/harness";

/** Claude Code / Codex service wrappers around non-conversational text (Codex's list). */
const CONTROL_WRAPPERS = [
  "command-message",
  "command-name",
  "command-args",
  "local-command-caveat",
  "local-command-stderr",
  "local-command-stdout",
  "task-notification",
  "system-reminder",
  "ide_opened_file",
  "ide_selection",
] as const;

const WRAPPER_BLOCK = new RegExp(`<(${CONTROL_WRAPPERS.join("|")})>[\\s\\S]*?</\\1>`, "g");

/** Context Codex injects as user-role items, not typed by a person (Cline's list). */
const INJECTED_PREFIXES = [
  "<user_instructions>",
  "<environment_context>",
  "<ENVIRONMENT_CONTEXT>",
  "<turn_aborted>",
  "# AGENTS.md instructions",
  "<INSTRUCTIONS>",
];

export function isInjectedContext(text: string): boolean {
  const start = text.trimStart();
  return INJECTED_PREFIXES.some((prefix) => start.startsWith(prefix));
}

/** Service wrappers removed wherever they are; `<user_query>` unwrapped (Cursor, Codex). */
export function stripControlWrappers(text: string): string {
  let out = text.replace(WRAPPER_BLOCK, "");
  const query = /^\s*<user_query>([\s\S]*?)<\/user_query>\s*$/u.exec(out);
  if (query) out = query[1]!;
  return out.trim();
}

/**
 * Invisible characters that carry hidden text: the harness's Default_Ignorable_Code_Point list (as NVIDIA
 * SkillSpector's) — zero-width, bidi, Unicode tags, variation selectors E0100…E0FFF, soft hyphen. People-safe
 * variant: ZWJ/ZWNJ and FE00–FE0F stay, emoji like «1️⃣» and «👨‍👩‍👧» and Persian/Indic words keep their shape.
 */
const INVISIBLE = INVISIBLE_FOR_PEOPLE;

export function removeInvisible(text: string): string {
  return text.replace(INVISIBLE, "");
}

/**
 * Names like API_KEY=…, token: …, password=… with a long value: the harness's rules cover known
 * key shapes, chats also hold made-up ones (research/25 §5). The name stays, the value goes.
 */
const NAMED_SECRET =
  /\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd)["']?\s*[=:]\s*["']?)([^\s"'`[\]]{8,})/giu;

export function scrub(text: string): { text: string; count: number } {
  const known = scrubSecrets(text);
  let count = known.count;
  const out = known.text.replace(NAMED_SECRET, (_whole, name: string) => {
    count += 1;
    return `${name}[СКРЫТО: секрет]`;
  });
  return { text: out, count };
}

/** Longest message kept (research/25 §5 «большие файлы»). */
export const MAX_MESSAGE_CHARS = 20_000;

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The whole cleaning for one message: invisible characters, secrets, length. */
export function cleanText(text: string): { text: string; secrets: number } {
  const visible = removeInvisible(text);
  const { text: scrubbed, count } = scrub(visible);
  return { text: truncate(scrubbed.trim(), MAX_MESSAGE_CHARS), secrets: count };
}

const NOTE_VALUE_CHARS = 200;
const NOTE_KEYS = [
  "command",
  "file_path",
  "file",
  "path",
  "pattern",
  "url",
  "query",
  "description",
];

function oneLine(text: string, max: number): string {
  return truncate(text.replace(/\s+/gu, " ").trim(), max);
}

/** «• Bash: npm test», «• Edit: index.html», «• WebFetch»: what the other agent did, no output. */
export function toolNote(name: string, input: unknown): string {
  const record =
    typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const key = NOTE_KEYS.find((k) => typeof record[k] === "string" && (record[k] as string).trim());
  const label = oneLine(name || "tool", 60);
  return key ? `• ${label}: ${oneLine(record[key] as string, NOTE_VALUE_CHARS)}` : `• ${label}`;
}

/** The file a tool touched, when it names one (for the summary's file list). */
export function toolFile(input: unknown): string | undefined {
  const record =
    typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const value = record.file_path ?? record.file ?? record.path;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** A failed tool's first 300 characters: the only tool output that crosses over. */
export function toolErrorNote(output: string): string {
  return `• ошибка инструмента: ${oneLine(output, 300)}`;
}

export const IMAGE_PLACEHOLDER = "[картинка не перенесена]";
