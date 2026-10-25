/**
 * Settings → «Поиск в интернете» (issue #23): which web search the agent uses, its key and fields. Keys at rest
 * like the gateway key — Electron safeStorage, one file per provider; the plain key lives in main memory and in
 * the Agent Host (handed over at spawn, removed from the host env at boot), never in the agent's env, never in
 * a JSON file. Non-secret choices (active provider, Yandex folder, SearXNG address) — search.json.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SearchProviderId, SearchProviderState, SearchState } from "@zeno/contracts";
import { maskKey, PrsloyKeyStore, type SecretCipher } from "./key-store.ts";

/** In the order of the settings screen: the gateway first, own keys, the model's search last. */
export const SEARCH_PROVIDER_IDS: readonly SearchProviderId[] = [
  "prsloy",
  "deepseek",
  "yandex",
  "searxng",
  "brave",
  "exa",
  "firecrawl",
  "jina",
  "model",
];

/** Providers that need a key of their own (SearXNG needs an address instead). */
const KEYED = new Set<SearchProviderId>([
  "deepseek",
  "yandex",
  "brave",
  "exa",
  "firecrawl",
  "jina",
]);

type Fields = { folderId?: string; url?: string };
type Stored = {
  active: SearchProviderId | null;
  fields: Partial<Record<SearchProviderId, Fields>>;
};

/** What the host gets: the active provider's config and the gateway address (no gateway key: Pi has it). */
export type SearchHandoff = {
  search: {
    provider: Exclude<SearchProviderId, "model">;
    key?: string;
    folderId?: string;
    url?: string;
  };
  gatewayUrl?: string;
};

export function isSearchProviderId(value: unknown): value is SearchProviderId {
  return typeof value === "string" && (SEARCH_PROVIDER_IDS as readonly string[]).includes(value);
}

export class SearchSettings {
  readonly #file: string;
  readonly #dir: string;
  readonly #cipher: SecretCipher;
  readonly #keys = new Map<SearchProviderId, PrsloyKeyStore>();

  /** `dir` — the PRSLOY state folder (next to gateway-key.bin). */
  constructor(dir: string, cipher: SecretCipher) {
    this.#dir = dir;
    this.#file = join(dir, "search.json");
    this.#cipher = cipher;
  }

  #store(id: SearchProviderId): PrsloyKeyStore {
    let s = this.#keys.get(id);
    if (!s) {
      s = new PrsloyKeyStore(join(this.#dir, `search-key-${id}.bin`), this.#cipher);
      this.#keys.set(id, s);
    }
    return s;
  }

  #read(): Stored {
    try {
      if (existsSync(this.#file)) {
        const raw = JSON.parse(readFileSync(this.#file, "utf8")) as Partial<Stored>;
        return {
          active: isSearchProviderId(raw.active) ? raw.active : null,
          fields: raw.fields && typeof raw.fields === "object" ? raw.fields : {},
        };
      }
    } catch {
      // broken file: search off, the user picks again
    }
    return { active: null, fields: {} };
  }

  #write(stored: Stored): void {
    mkdirSync(dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(stored, null, 2), "utf8");
    renameSync(tmp, this.#file);
  }

  /** Is this provider usable now? `prsloy` needs the PRSLOY key, SearXNG an address, Yandex a key and a folder. */
  #configured(id: SearchProviderId, fields: Fields, gatewayKey: boolean): boolean {
    if (id === "model") return true;
    if (id === "prsloy") return gatewayKey;
    if (id === "searxng") return Boolean(fields.url);
    if (id === "yandex") return Boolean(this.#store(id).read() && fields.folderId);
    return Boolean(this.#store(id).read());
  }

  state(gatewayKey: boolean): SearchState {
    const stored = this.#read();
    const providers: SearchProviderState[] = SEARCH_PROVIDER_IDS.map((id) => {
      const fields = stored.fields[id] ?? {};
      const key = KEYED.has(id) ? this.#store(id).read() : undefined;
      return {
        id,
        configured: this.#configured(id, fields, gatewayKey),
        ...(key ? { keyMask: maskKey(key) } : {}),
        ...(fields.folderId || fields.url ? { fields: { ...fields } } : {}),
      };
    });
    return { active: stored.active, providers };
  }

  /** Store a provider's key (empty for SearXNG and fields-only updates) and its non-secret fields. */
  setKey(id: SearchProviderId, key: string, fields: Fields = {}): void {
    if (id === "prsloy" || id === "model") throw new Error("Этому поиску ключ не нужен");
    if (key.trim()) this.#store(id).write(key);
    const stored = this.#read();
    const next: Fields = { ...stored.fields[id] };
    for (const name of ["folderId", "url"] as const) {
      const value = fields[name]?.trim();
      if (value) next[name] = value;
      else if (value === "") delete next[name];
    }
    stored.fields[id] = next;
    this.#write(stored);
  }

  clearKey(id: SearchProviderId): void {
    this.#store(id).clear();
    const stored = this.#read();
    delete stored.fields[id];
    if (stored.active === id) stored.active = null;
    this.#write(stored);
  }

  setActive(id: SearchProviderId | null): void {
    const stored = this.#read();
    stored.active = id;
    this.#write(stored);
  }

  /** The active provider's config for «Проверить» and for the host; undefined — search off or not set up. */
  config(id: SearchProviderId | null, gatewayUrl?: string): SearchHandoff["search"] | undefined {
    if (!id || id === "model") return undefined;
    const fields = this.#read().fields[id] ?? {};
    if (id === "prsloy") return { provider: "prsloy", ...(gatewayUrl ? { url: gatewayUrl } : {}) };
    const key = KEYED.has(id) ? this.#store(id).read() : undefined;
    if (KEYED.has(id) && !key) return undefined;
    return {
      provider: id,
      ...(key ? { key } : {}),
      ...(fields.folderId ? { folderId: fields.folderId } : {}),
      ...(fields.url ? { url: fields.url } : {}),
    };
  }

  /** JSON the host takes (and deletes from its env) at boot; undefined — no web search tools this session. */
  handoff(gatewayUrl: string | undefined): string | undefined {
    const search = this.config(this.#read().active, gatewayUrl);
    if (!search) return undefined;
    const handoff: SearchHandoff = { search, ...(gatewayUrl ? { gatewayUrl } : {}) };
    return JSON.stringify(handoff);
  }
}
