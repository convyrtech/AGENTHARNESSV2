/**
 * Settings → «Поиск в интернете» IPC (issue #23). Inputs from the renderer are untrusted: provider ids from the
 * list, strings capped, addresses http(s) only. «Проверить» runs here, in main, from the user's own network:
 * one query «Пушкин», 1 result (research/26 §3.7). A change to the active search restarts the Agent Host when
 * it is idle, so the next session gets the new search; a busy agent picks it up at its next start.
 */
import type { SearchCheckResult, SearchProviderId, SearchState } from "@zeno/contracts";
import { checkProvider } from "@prsloy/harness/research/search";
import type { IpcMainLike } from "./ipc.ts";
import { isSearchProviderId, type SearchSettings } from "./search-settings.ts";

export const SEARCH_IPC = {
  getState: "prsloy:search:get-state",
  setKey: "prsloy:search:set-key",
  clearKey: "prsloy:search:clear-key",
  setActive: "prsloy:search:set-active",
  check: "prsloy:search:check",
} as const;

const MAX_KEY = 4096;
const MAX_FIELD = 2048;

export type SearchIpcDeps = {
  settings: SearchSettings;
  /** The PRSLOY key, for «Поиск PRSLOY» and its check. */
  gatewayKey(): string | undefined;
  /** The gateway address (`…/v1`). */
  gatewayUrl(): string | undefined;
  isAgentBusy(): boolean;
  restartHost(): Promise<void>;
  fetch?: typeof fetch;
};

function provider(raw: unknown): SearchProviderId {
  if (!isSearchProviderId(raw)) throw new Error("Неизвестный поиск");
  return raw;
}

function fields(raw: unknown): { folderId?: string; url?: string } {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object") throw new Error("Неверные поля");
  const r = raw as Record<string, unknown>;
  const out: { folderId?: string; url?: string } = {};
  if (typeof r.folderId === "string") out.folderId = r.folderId.slice(0, MAX_FIELD);
  if (typeof r.url === "string") {
    const url = r.url.trim().slice(0, MAX_FIELD);
    if (url && !/^https?:\/\/[^\s/]+/i.test(url))
      throw new Error("Адрес сервера должен начинаться с http:// или https://");
    out.url = url;
  }
  return out;
}

export function registerPrsloySearchIpc(ipcMain: IpcMainLike, deps: SearchIpcDeps): void {
  const state = (): SearchState => deps.settings.state(Boolean(deps.gatewayKey()));
  const applied = async (): Promise<SearchState> => {
    if (!deps.isAgentBusy()) await deps.restartHost().catch(() => undefined);
    return state();
  };

  ipcMain.handle(SEARCH_IPC.getState, () => state());
  ipcMain.handle(SEARCH_IPC.setKey, async (_e, id, key, f) => {
    if (typeof key !== "string" || key.length > MAX_KEY) throw new Error("Неверный ключ");
    deps.settings.setKey(provider(id), key, fields(f));
    return applied();
  });
  ipcMain.handle(SEARCH_IPC.clearKey, async (_e, id) => {
    deps.settings.clearKey(provider(id));
    return applied();
  });
  ipcMain.handle(SEARCH_IPC.setActive, async (_e, id) => {
    deps.settings.setActive(id === null ? null : provider(id));
    return applied();
  });
  ipcMain.handle(SEARCH_IPC.check, async (_e, raw): Promise<SearchCheckResult> => {
    const id = provider(raw);
    if (id === "model") {
      return {
        ok: false,
        code: "no_channel",
        error: "Встроенный поиск модели проверяется в чате: источники у него не проверяются кодом",
      };
    }
    const cfg = deps.settings.config(id, deps.gatewayUrl());
    if (!cfg) return { ok: false, code: "no_key", error: "Сначала введите ключ" };
    const effective = id === "prsloy" ? { ...cfg, key: deps.gatewayKey() ?? "" } : cfg;
    if (id === "prsloy" && !effective.key)
      return { ok: false, code: "no_key", error: "Нет ключа PRSLOY" };
    return checkProvider(effective, deps.fetch ? { fetchImpl: deps.fetch } : {});
  });
}
