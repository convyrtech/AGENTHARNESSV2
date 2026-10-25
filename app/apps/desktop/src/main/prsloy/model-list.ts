/**
 * The models come from the gateway, not from a fixed list: `/v1/models` is read when the
 * key is checked, once at startup and every hour. A change rewrites models.json (only what
 * the gateway serves; presets move to the next model of their list) and the host reloads
 * its catalog.
 */
import { checkPrsloyKey, type FetchLike } from "./gateway-check.ts";
import type { PrsloyContext } from "./context.ts";

export const MODEL_LIST_REFRESH_MS = 60 * 60 * 1000;

export async function refreshPrsloyModels(options: {
  ctx: Pick<PrsloyContext, "keyStore" | "getState" | "setAvailableModels">;
  fetch: FetchLike;
  onChanged?: () => Promise<void> | void;
}): Promise<boolean> {
  const key = options.ctx.keyStore.read();
  if (!key) return false;
  const check = await checkPrsloyKey({
    baseUrl: options.ctx.getState().baseUrl,
    apiKey: key,
    fetch: options.fetch,
  });
  // Offline, a bad key or a gateway without /models: keep what we knew.
  if (!check.ok || check.via !== "models" || check.modelIds.length === 0) return false;
  if (!options.ctx.setAvailableModels(check.modelIds)) return false;
  await options.onChanged?.();
  return true;
}

export function startPrsloyModelRefresh(options: {
  ctx: Pick<PrsloyContext, "keyStore" | "getState" | "setAvailableModels">;
  fetch: FetchLike;
  onChanged?: () => Promise<void> | void;
  intervalMs?: number;
}): { stop(): void; refresh(): Promise<boolean> } {
  const refresh = () =>
    refreshPrsloyModels(options).catch((error: unknown) => {
      console.warn("[prsloy] model list refresh failed:", error);
      return false;
    });
  void refresh();
  const timer = setInterval(() => void refresh(), options.intervalMs ?? MODEL_LIST_REFRESH_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer), refresh };
}
