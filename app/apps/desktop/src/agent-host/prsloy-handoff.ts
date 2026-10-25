/**
 * Take PRSLOY values main handed over through the spawn env, then remove the gateway
 * key from `process.env` so no tool process (pi bash inherits this env) can read it.
 * The key lives on only in memory and as a pi runtime key.
 *
 * Imported for its side effect before the runtime; keep it dependency-free.
 */

export const GATEWAY_KEY_HANDOFF_ENV = "PRSLOY_GATEWAY_KEY";
export const HARNESS_EXTENSIONS_ENV = "PRSLOY_HARNESS_EXTENSIONS";

export type PrsloyHandoff = {
  gatewayKey?: string;
  /** Extension sources for every session (prsloy-harness package). */
  harnessExtensions: string[];
};

export function takePrsloyHandoff(env: NodeJS.ProcessEnv): PrsloyHandoff {
  const gatewayKey = env[GATEWAY_KEY_HANDOFF_ENV]?.trim();
  delete env[GATEWAY_KEY_HANDOFF_ENV];
  let harnessExtensions: string[] = [];
  const raw = env[HARNESS_EXTENSIONS_ENV];
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        harnessExtensions = parsed.filter(
          (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
        );
      }
    } catch {
      harnessExtensions = [];
    }
  }
  return { ...(gatewayKey ? { gatewayKey } : {}), harnessExtensions };
}

export const prsloyHandoff: PrsloyHandoff = takePrsloyHandoff(process.env);
