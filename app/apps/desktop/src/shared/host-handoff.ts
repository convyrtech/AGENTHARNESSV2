/**
 * Secrets main hands to the Agent Host: the gateway key and the web search config (its keys,
 * issue #23). One message over the utility process's parentPort, right after the fork and before
 * any command — never the spawn env: on Linux a child of the host (pi bash) reads the host's
 * original environment from /proc/<ppid>/environ even after `delete process.env.X`.
 */

export const HOST_HANDOFF_TYPE = "prsloy.handoff";

/** Web search provider and its keys, as main's search settings write them (search-settings.ts). */
export type HostSearchHandoff = {
  search: { provider: string; key?: string; folderId?: string; url?: string; models?: string[] };
  /** Other set-up own-key providers, in order: the fallback after the active one (issue #48). */
  fallbacks?: HostSearchHandoff["search"][];
  gatewayUrl?: string;
  githubToken?: string;
  modelSearch?: string[];
};

export type HostHandoffMessage = {
  type: typeof HOST_HANDOFF_TYPE;
  gatewayKey?: string;
  search?: HostSearchHandoff;
};

const MAX_KEY = 4096;

export function isHostHandoff(value: unknown): value is HostHandoffMessage {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.type !== HOST_HANDOFF_TYPE) return false;
  if (
    v.gatewayKey !== undefined &&
    (typeof v.gatewayKey !== "string" || v.gatewayKey.length > MAX_KEY)
  )
    return false;
  if (v.search !== undefined) {
    const s = v.search as { search?: { provider?: unknown } } | null;
    if (!s || typeof s !== "object" || typeof s.search?.provider !== "string") return false;
  }
  return true;
}

/** The search config main writes as JSON (search-settings `handoff()`); undefined when unusable. */
export function parseSearchHandoff(raw: string | undefined): HostSearchHandoff | undefined {
  if (!raw) return undefined;
  try {
    const data = JSON.parse(raw) as HostSearchHandoff;
    return typeof data?.search?.provider === "string" ? data : undefined;
  } catch {
    return undefined;
  }
}
