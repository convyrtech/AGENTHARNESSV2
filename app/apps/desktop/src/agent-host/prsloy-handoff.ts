/**
 * Take the gateway key main handed over through the spawn env, then remove it from
 * `process.env` so no tool process (pi bash inherits this env) can read it. The key
 * lives on only in memory and as a pi runtime key.
 *
 * Imported for its side effect before the runtime; keep it dependency-free.
 */

export const GATEWAY_KEY_HANDOFF_ENV = "PRSLOY_GATEWAY_KEY";
/** Web search provider and key (issue #23): JSON from main, taken and deleted the same way. */
export const SEARCH_HANDOFF_ENV = "PRSLOY_SEARCH_HANDOFF";

export type SearchHandoff = {
  search: { provider: string; key?: string; folderId?: string; url?: string; models?: string[] };
  gatewayUrl?: string;
  githubToken?: string;
  modelSearch?: string[];
};

export type PrsloyHandoff = {
  gatewayKey?: string;
  search?: SearchHandoff;
  /** prsloy-harness extensions on every session (`PRSLOY_HARNESS=0` turns them off). */
  harnessEnabled: boolean;
};

export function takePrsloyHandoff(env: NodeJS.ProcessEnv): PrsloyHandoff {
  const gatewayKey = env[GATEWAY_KEY_HANDOFF_ENV]?.trim();
  delete env[GATEWAY_KEY_HANDOFF_ENV];
  const search = parseSearch(env[SEARCH_HANDOFF_ENV]);
  delete env[SEARCH_HANDOFF_ENV];
  return {
    ...(gatewayKey ? { gatewayKey } : {}),
    ...(search ? { search } : {}),
    harnessEnabled: env.PRSLOY_HARNESS !== "0",
  };
}

function parseSearch(raw: string | undefined): SearchHandoff | undefined {
  if (!raw) return undefined;
  try {
    const data = JSON.parse(raw) as SearchHandoff;
    return typeof data?.search?.provider === "string" ? data : undefined;
  } catch {
    return undefined;
  }
}

export const prsloyHandoff: PrsloyHandoff = takePrsloyHandoff(process.env);
