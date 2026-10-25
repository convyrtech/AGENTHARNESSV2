/**
 * Settings → «Поиск в интернете» (issue #23): which web search the agent uses, its key and fields. Keys at rest
 * like the gateway key — Electron safeStorage, one file per provider; the plain key lives in main memory and in
 * the Agent Host (handed over at spawn, removed from the host env at boot), never in the agent's env, never in
 * a JSON file. Non-secret choices (active provider, Yandex folder, SearXNG address, the last check) — search.json.
 * The default is the free search (no key); the agent falls back to it, then to the model's search.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  SearchCheckResult,
  SearchProviderId,
  SearchProviderState,
  SearchState,
} from "@zeno/contracts";
import { maskKey, PrsloyKeyStore, type SecretCipher } from "./key-store.ts";

/** In the order of the settings screen: free first, own keys, the gateway (#31), the model's search last. */
export const SEARCH_PROVIDER_IDS: readonly SearchProviderId[] = [
  "free",
  "deepseek",
  "yandex",
  "searxng",
  "brave",
  "exa",
  "firecrawl",
  "jina",
  "github",
  "prsloy",
  "model",
];

export const DEFAULT_SEARCH: SearchProviderId = "free";
/** Models whose built-in web search works on the owner's gateway (the conductor's probe, 2026-10-25). */
export const DEFAULT_MODEL_SEARCH: readonly string[] = ["gpt-6.1-sol"];
const MODEL_ID = /^[\w.:/-]{1,128}$/;
/** No key of their own: free needs nothing, prsloy and model use the PRSLOY key. */
const KEYLESS = new Set<SearchProviderId>(["free", "prsloy", "model"]);

/** Providers that need a key of their own (SearXNG needs an address instead). */
const KEYED = new Set<SearchProviderId>([
  "deepseek",
  "yandex",
  "brave",
  "exa",
  "firecrawl",
  "jina",
  // a token of the user's own: the free search goes to GitHub with it too (higher limits, code search)
  "github",
]);

type Fields = { folderId?: string; url?: string; models?: string[] };
type LastCheck = NonNullable<SearchProviderState["lastCheck"]>;
type Stored = {
  active: SearchProviderId | null;
  fields: Partial<Record<SearchProviderId, Fields>>;
  checks: Partial<Record<SearchProviderId, LastCheck>>;
};

/** What the host gets: the active provider's config and the gateway address (no gateway key: Pi has it). */
export type SearchHandoff = {
  search: {
    provider: SearchProviderId;
    key?: string;
    folderId?: string;
    url?: string;
    models?: string[];
  };
  gatewayUrl?: string;
  /** The user's GitHub token, if set: the free search uses it whatever provider is active. */
  githubToken?: string;
  /** Models for the model's search fallback, in order. */
  modelSearch?: string[];
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
          active:
            isSearchProviderId(raw.active) || raw.active === null ? raw.active : DEFAULT_SEARCH,
          fields: raw.fields && typeof raw.fields === "object" ? raw.fields : {},
          checks: raw.checks && typeof raw.checks === "object" ? raw.checks : {},
        };
      }
    } catch {
      // broken file: the free search, the user picks again
    }
    return { active: DEFAULT_SEARCH, fields: {}, checks: {} };
  }

  #write(stored: Stored): void {
    mkdirSync(dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(stored, null, 2), "utf8");
    renameSync(tmp, this.#file);
  }

  /**
   * Is this provider usable now? Free — always; `prsloy` and `model` need the PRSLOY key, SearXNG an address,
   * Yandex a key and a folder.
   */
  #configured(id: SearchProviderId, fields: Fields, gatewayKey: boolean): boolean {
    if (id === "free") return true;
    if (id === "prsloy" || id === "model") return gatewayKey;
    if (id === "searxng") return Boolean(fields.url);
    if (id === "yandex") return Boolean(this.#store(id).read() && fields.folderId);
    return Boolean(this.#store(id).read());
  }

  state(gatewayKey: boolean): SearchState {
    const stored = this.#read();
    const providers: SearchProviderState[] = SEARCH_PROVIDER_IDS.map((id) => {
      const fields: Fields =
        id === "model" ? { models: this.#models(stored) } : (stored.fields[id] ?? {});
      const key = KEYED.has(id) ? this.#store(id).read() : undefined;
      const lastCheck = stored.checks[id];
      return {
        id,
        configured: this.#configured(id, fields, gatewayKey),
        ...(key ? { keyMask: maskKey(key) } : {}),
        ...(fields.folderId || fields.url || fields.models ? { fields: { ...fields } } : {}),
        ...(lastCheck ? { lastCheck: { ...lastCheck } } : {}),
      };
    });
    return { active: stored.active, providers };
  }

  /**
   * Store a provider's key and its non-secret fields. A blank key is an error; SearXNG takes no key but needs an
   * address; free, prsloy and model take nothing.
   */
  setKey(id: SearchProviderId, key: string, fields: Fields = {}): void {
    if (KEYLESS.has(id)) throw new Error("Этому поиску ключ не нужен");
    if (id === "searxng") {
      if (!fields.url?.trim()) throw new Error("Нужен адрес сервера SearXNG");
    } else if (!key.trim()) {
      throw new Error("Ключ пустой");
    } else {
      this.#store(id).write(key.trim());
    }
    const stored = this.#read();
    const next: Fields = { ...stored.fields[id] };
    for (const name of ["folderId", "url"] as const) {
      const value = fields[name]?.trim();
      if (value) next[name] = value;
      else if (value === "") delete next[name];
    }
    stored.fields[id] = next;
    // a new key or address: the old check no longer says anything
    delete stored.checks[id];
    this.#write(stored);
  }

  /** Models with built-in web search for the last fallback, in order (from the gateway's catalog). */
  setModels(models: readonly string[]): void {
    const list = [...new Set(models.map((m) => m.trim()).filter(Boolean))];
    if (!list.length) throw new Error("Нужна хотя бы одна модель");
    if (list.length > 10 || list.some((m) => !MODEL_ID.test(m)))
      throw new Error("Неверный список моделей");
    const stored = this.#read();
    stored.fields.model = { models: list };
    delete stored.checks.model;
    this.#write(stored);
  }

  #models(stored: Stored): string[] {
    const list = stored.fields.model?.models;
    return Array.isArray(list) &&
      list.every((m) => typeof m === "string" && MODEL_ID.test(m)) &&
      list.length
      ? [...list]
      : [...DEFAULT_MODEL_SEARCH];
  }

  clearKey(id: SearchProviderId): void {
    this.#store(id).clear();
    const stored = this.#read();
    delete stored.fields[id];
    delete stored.checks[id];
    if (stored.active === id) stored.active = DEFAULT_SEARCH;
    this.#write(stored);
  }

  setActive(id: SearchProviderId | null): void {
    const stored = this.#read();
    stored.active = id;
    this.#write(stored);
  }

  /** «Проверить» result, shown next to the provider until its key or address changes. */
  recordCheck(id: SearchProviderId, result: SearchCheckResult, at: Date = new Date()): void {
    const stored = this.#read();
    stored.checks[id] = {
      at: at.toISOString(),
      ok: result.ok,
      ...(result.ok ? {} : { code: result.code }),
    };
    this.#write(stored);
  }

  /**
   * A provider's config for «Проверить» and for the host; undefined — not set up. `prsloy` and `model` carry the
   * gateway address only: the key is the PRSLOY key, which Pi (or main for the check) adds.
   */
  config(id: SearchProviderId | null, gatewayUrl?: string): SearchHandoff["search"] | undefined {
    if (!id) return undefined;
    if (id === "free") return { provider: "free" };
    const stored = this.#read();
    const fields = stored.fields[id] ?? {};
    if (id === "prsloy") return { provider: id, ...(gatewayUrl ? { url: gatewayUrl } : {}) };
    if (id === "model")
      return {
        provider: id,
        ...(gatewayUrl ? { url: gatewayUrl } : {}),
        models: this.#models(stored),
      };
    const key = KEYED.has(id) ? this.#store(id).read() : undefined;
    if (KEYED.has(id) && !key) return undefined;
    return {
      provider: id,
      ...(key ? { key } : {}),
      ...(fields.folderId ? { folderId: fields.folderId } : {}),
      ...(fields.url ? { url: fields.url } : {}),
    };
  }

  /**
   * JSON the host takes (and deletes from its env) at boot. Always set: an active provider that is not set up
   * (its key was removed) falls back to the free search. Whether the agent has the tools is the `webTools` flag.
   */
  handoff(gatewayUrl: string | undefined): string {
    const search = this.config(this.#read().active ?? DEFAULT_SEARCH, gatewayUrl) ?? {
      provider: "free" as const,
    };
    const githubToken = this.#store("github").read();
    const handoff: SearchHandoff = {
      search,
      ...(gatewayUrl ? { gatewayUrl } : {}),
      ...(githubToken ? { githubToken } : {}),
      modelSearch: this.#models(this.#read()),
    };
    return JSON.stringify(handoff);
  }
}
