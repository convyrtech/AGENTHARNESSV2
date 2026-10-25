/**
 * Settings → «Поиск в интернете» (issue #23, research/26 §3.7–3.8): which web search the agent uses and its key.
 * Keys are entered and kept in main (Electron safeStorage, like the gateway key); the renderer only ever sees a
 * mask, and the agent gets the search tool, not the key.
 */

/**
 * `free` — the default, no key: official sources (GitHub, npm, PyPI, endoflife.date, Wikipedia) and a keyless
 * web search, always configured; `prsloy` — «Поиск PRSLOY» through the gateway (no key of its own: the PRSLOY
 * key, issue #31); `model` — the model's built-in search, the last fallback, sources unchecked by code. Tavily is
 * not offered: its terms bar users in Russia (research/26 §3.2). `github` — the user's own GitHub token (optional):
 * as the active provider it searches repositories, issues and code; set at all, the free search uses it too
 * (higher limits). Screen order: free, own keys (github last of them), prsloy, model.
 */
export type SearchProviderId =
  | "free"
  | "prsloy"
  | "deepseek"
  | "yandex"
  | "searxng"
  | "brave"
  | "exa"
  | "firecrawl"
  | "jina"
  | "github"
  | "model";

export type SearchProviderState = {
  id: SearchProviderId;
  /**
   * A key (and the required fields) is stored; SearXNG — its address; `free` — always; `prsloy` and `model` —
   * the PRSLOY key is set.
   */
  configured: boolean;
  /** «sk-…a1b2»: the key itself never leaves main. */
  keyMask?: string;
  /**
   * Not secret: Yandex folder ID, SearXNG server address; `model` — the models whose built-in search is tried, in
   * order (default ["gpt-6.1-sol"]).
   */
  fields?: { folderId?: string; url?: string; models?: string[] };
  /** The last «Проверить», stored by main. */
  lastCheck?: { at: string; ok: boolean; code?: SearchErrorCode };
};

export type SearchErrorCode = "no_key" | "auth" | "limit" | "network" | "format" | "no_channel";

export type SearchState = {
  /**
   * The provider tried first; the agent falls back to `free`, then `model`. Default `free`. `null` (kept for
   * older files) means the same as `free`. The tools themselves are behind the harness flag `webTools`.
   */
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
      code: SearchErrorCode;
    };

/**
 * `details` of the card the harness shows when a search provider stops working mid-session: `customType`
 * "prsloy-harness.search-limit", `display: true`. The agent goes on down the chain.
 */
export type SearchLimitCardDetails = {
  provider: SearchProviderId;
  code: "limit" | "auth" | "no_key";
};

export interface SearchApi {
  getState(): Promise<SearchState>;
  /**
   * A blank key is an error; SearXNG takes no key (pass "") but needs `fields.url`. `free`, `prsloy` and `model`
   * take no key.
   */
  setKey(
    id: SearchProviderId,
    key: string,
    fields?: { folderId?: string; url?: string },
  ): Promise<SearchState>;
  clearKey(id: SearchProviderId): Promise<SearchState>;
  setActive(id: SearchProviderId | null): Promise<SearchState>;
  /**
   * The models for the model's search fallback, in order — from the gateway's catalog, those whose built-in search
   * works. Non-empty, at most 10.
   */
  setModels(models: string[]): Promise<SearchState>;
  /** One query «Пушкин», 1 result, from the user's own network; the result is stored as `lastCheck`. */
  check(id: SearchProviderId): Promise<SearchCheckResult>;
}

/**
 * What the Agent Host gets for web search (review #23, item 5): in the prsloy.handoff message over its parentPort
 * (apps/desktop/src/shared/host-handoff.ts), never its env, and only while the harness flag `webTools` is on.
 */
export type PrsloySearchHandoff = {
  search: {
    provider: SearchProviderId;
    key?: string;
    folderId?: string;
    url?: string;
    models?: string[];
  };
  gatewayUrl?: string;
  githubToken?: string;
  modelSearch?: string[];
};
