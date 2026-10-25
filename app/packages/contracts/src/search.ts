/**
 * Settings → «Поиск в интернете» (issue #23, research/26 §3.7–3.8): which web search the agent uses and its key.
 * Keys are entered and kept in main (Electron safeStorage, like the gateway key); the renderer only ever sees a
 * mask, and the agent gets the search tool, not the key.
 */

/**
 * `prsloy` — «Поиск PRSLOY» through the gateway (no key of its own: the PRSLOY key); `model` — the model's
 * built-in search, a fallback with sources unchecked by code. Tavily is not offered: its terms bar users in
 * Russia (research/26 §3.2).
 */
export type SearchProviderId =
  | "prsloy"
  | "deepseek"
  | "yandex"
  | "searxng"
  | "brave"
  | "exa"
  | "firecrawl"
  | "jina"
  | "model";

export type SearchProviderState = {
  id: SearchProviderId;
  /** A key (and the required fields) is stored; `prsloy` — the PRSLOY key is set; `model` — always. */
  configured: boolean;
  /** «sk-…a1b2»: the key itself never leaves main. */
  keyMask?: string;
  /** Not secret: Yandex folder ID, SearXNG server address. */
  fields?: { folderId?: string; url?: string };
};

export type SearchState = {
  /** `null` — web search is off. */
  active: SearchProviderId | null;
  providers: SearchProviderState[];
};

export type SearchCheckResult =
  | {
      ok: true;
      latencyMs: number;
      /** The results carry publication dates. */
      dated: boolean;
      firstUrl: string;
      note?: string;
    }
  | {
      ok: false;
      error: string;
      /** `limit` → the card «лимит поиска исчерпан, добавьте ключ или выберите другой поиск». */
      code: "no_key" | "auth" | "limit" | "network" | "format" | "no_channel";
    };

export interface SearchApi {
  getState(): Promise<SearchState>;
  setKey(
    id: SearchProviderId,
    key: string,
    fields?: { folderId?: string; url?: string },
  ): Promise<SearchState>;
  clearKey(id: SearchProviderId): Promise<SearchState>;
  /** `null` turns web search off. */
  setActive(id: SearchProviderId | null): Promise<SearchState>;
  /** One query «Пушкин», 1 result, from the user's own network. */
  check(id: SearchProviderId): Promise<SearchCheckResult>;
}
