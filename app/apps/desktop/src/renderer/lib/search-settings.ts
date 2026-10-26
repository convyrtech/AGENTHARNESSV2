/**
 * Settings → «Поиск в интернете» (issue #23, research/26 §3.7): the order of the providers, what each
 * one asks for, and the plain words for a check. Keys live in main; this file only sees masks.
 */
import type {
  SearchCheckResult,
  SearchErrorCode,
  SearchLimitCardDetails,
  SearchProviderId,
  SearchProviderState,
  SearchState,
} from "@zeno/contracts";
import { PRSLOY_MODELS } from "../../shared/prsloy-config.ts";
import type { MessageKey } from "./i18n.ts";

/** Free first, own keys next, the gateway, the model's own search last (design, #23). */
export const SEARCH_ORDER: readonly SearchProviderId[] = [
  "free",
  "deepseek",
  "yandex",
  "searxng",
  "brave",
  "exa",
  "tavily",
  "firecrawl",
  "jina",
  "github",
  "prsloy",
  "model",
];

/** The day the «где взять ключ» hints were compared with the providers' documentation. */
export const HINTS_CHECKED_ON = "2026-10-25";

/** What the form asks for: a key, a key and a Yandex folder, a SearXNG address, or nothing. */
export type SearchForm = "key" | "keyFolder" | "url" | "none";

export function searchForm(id: SearchProviderId): SearchForm {
  if (id === "yandex") return "keyFolder";
  if (id === "searxng") return "url";
  if (id === "free" || id === "prsloy" || id === "model") return "none";
  return "key";
}

/** `null` from older files means the same as free. */
export function activeProvider(state: SearchState): SearchProviderId {
  return state.active ?? "free";
}

/** The providers in screen order; ones main does not report are left out. */
export function orderedProviders(state: SearchState): SearchProviderState[] {
  const byId = new Map(state.providers.map((p) => [p.id, p]));
  return SEARCH_ORDER.flatMap((id) => {
    const provider = byId.get(id);
    return provider ? [provider] : [];
  });
}

const ERROR_KEYS: Record<SearchErrorCode, MessageKey> = {
  no_key: "features.web.error.no_key",
  auth: "features.web.error.auth",
  limit: "features.web.error.limit",
  network: "features.web.error.network",
  format: "features.web.error.format",
  no_channel: "features.web.error.no_channel",
};

export function searchErrorKey(code: SearchErrorCode | undefined): MessageKey {
  return (code && ERROR_KEYS[code]) || "features.web.error.network";
}

/** «Работает из вашей сети · 420 мс · даты есть» or «Не работает: ключ не подошёл». */
export function checkLine(
  tr: (key: MessageKey, vars?: Record<string, string>) => string,
  result: SearchCheckResult,
): string {
  if (!result.ok) {
    return tr("features.web.checkFailed", { reason: tr(searchErrorKey(result.code)) });
  }
  const parts = [
    tr("features.web.checkOk"),
    tr("features.web.latency", { ms: String(Math.round(result.latencyMs)) }),
    tr(result.dated ? "features.web.dated" : "features.web.undated"),
  ];
  if (result.note) parts.push(result.note);
  return parts.join(" · ");
}

/** «Проверено 25 окт. · работает» from what main stored after the last check. */
export function lastCheckLine(
  tr: (key: MessageKey, vars?: Record<string, string>) => string,
  localeTag: string,
  lastCheck: SearchProviderState["lastCheck"],
): string | undefined {
  if (!lastCheck) return undefined;
  const date = new Date(lastCheck.at);
  if (Number.isNaN(date.getTime())) return undefined;
  const day = date.toLocaleDateString(localeTag, { day: "numeric", month: "short" });
  return tr(lastCheck.ok ? "features.web.lastOk" : "features.web.lastFailed", {
    date: day,
    reason: lastCheck.ok ? "" : tr(searchErrorKey(lastCheck.code)),
  });
}

export function hintKey(id: SearchProviderId): MessageKey {
  return `features.web.hint.${id}` as MessageKey;
}

export function nameKey(id: SearchProviderId): MessageKey {
  return `features.web.name.${id}` as MessageKey;
}

/** The harness's card when a search ran out or refused (issue #23). */
export const SEARCH_LIMIT_TYPE = "prsloy-harness.search-limit";

export function parseLimitDetails(details: unknown): SearchLimitCardDetails | undefined {
  if (!details || typeof details !== "object") return undefined;
  const { provider, code } = details as Record<string, unknown>;
  if (typeof provider !== "string" || !(SEARCH_ORDER as readonly string[]).includes(provider)) {
    return undefined;
  }
  if (code !== "limit" && code !== "auth" && code !== "no_key") return undefined;
  return { provider: provider as SearchProviderId, code };
}

/**
 * «Добавить ключ» on the card opens the settings page with that provider's form already open; the
 * page takes the request once.
 */
let pendingEdit: SearchProviderId | undefined;

export function requestKeyForm(id: SearchProviderId | undefined): void {
  pendingEdit = id;
}

export function takeKeyFormRequest(): SearchProviderId | undefined {
  const id = pendingEdit;
  pendingEdit = undefined;
  return id;
}

/** The model search tries at most this many models (design's `setModels`). */
export const MAX_SEARCH_MODELS = 10;

/** The gateway's catalog for the model search: id and the name people know. */
export const SEARCH_MODEL_CATALOG: readonly { id: string; name: string }[] = PRSLOY_MODELS.map(
  (model) => ({ id: model.id, name: model.name }),
);

export function searchModelName(id: string): string {
  return SEARCH_MODEL_CATALOG.find((model) => model.id === id)?.name ?? id;
}

/** The list with the model at `index` one place higher. */
export function moveUp<T>(list: readonly T[], index: number): T[] {
  if (index <= 0 || index >= list.length) return [...list];
  const next = [...list];
  [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
  return next;
}
