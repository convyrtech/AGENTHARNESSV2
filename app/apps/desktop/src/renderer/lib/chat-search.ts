/**
 * Search over old chats in the command palette (research 19 §1.6). Main searches pi's
 * session files; here: when to ask, and how a result reads.
 */
import type { ChatSearchResult } from "@zeno/contracts";
import { t, type Locale } from "./i18n.ts";

/** One letter finds everything: wait for two. */
export const CHAT_SEARCH_MIN_CHARS = 2;
export const CHAT_SEARCH_DEBOUNCE_MS = 200;

export function shouldSearchChats(query: string): boolean {
  return query.trim().length >= CHAT_SEARCH_MIN_CHARS;
}

export function chatResultTitle(locale: Locale, result: ChatSearchResult): string {
  return result.title.trim() || t(locale, "features.search.untitled");
}

/** The first place that matched; nothing when it only repeats the title or the name matched. */
export function chatResultSnippet(result: ChatSearchResult): string {
  const snippet = result.matches[0]?.snippet ?? "";
  return snippet.replace(/^…|…$/gu, "") === result.title.trim() ? "" : snippet;
}

/** Ask main; a failed call is just no results. */
export async function searchChats(query: string): Promise<ChatSearchResult[]> {
  if (!shouldSearchChats(query)) return [];
  return window.zeno.features.searchChats(query.trim()).catch(() => []);
}
