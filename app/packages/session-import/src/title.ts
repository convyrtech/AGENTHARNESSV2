/**
 * A chat's title: the owner's own name for it, then the agent's, then the first line of the
 * first request, at most 120 characters (the order Codex and Cline use).
 *
 * Portions adapted from openai/codex (Apache-2.0, © 2025 OpenAI),
 * codex-rs/external-agent-migration/src/sessions/title.rs @ 970111f.
 */
import { stripControlWrappers, truncate } from "./clean.ts";

export const TITLE_MAX_CHARS = 120;
export const FALLBACK_TITLE = "Перенесённый чат";

export function pickTitle(candidates: {
  customTitle?: string | undefined;
  aiTitle?: string | undefined;
  firstRequest?: string | undefined;
}): string {
  for (const value of [candidates.customTitle, candidates.aiTitle]) {
    const title = value?.replace(/\s+/gu, " ").trim();
    if (title) return truncate(title, TITLE_MAX_CHARS);
  }
  const line = stripControlWrappers(candidates.firstRequest ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  return line ? truncate(line, TITLE_MAX_CHARS) : FALLBACK_TITLE;
}
