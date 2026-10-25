/**
 * Take the gateway key main handed over through the spawn env, then remove it from
 * `process.env` so no tool process (pi bash inherits this env) can read it. The key
 * lives on only in memory and as a pi runtime key.
 *
 * Imported for its side effect before the runtime; keep it dependency-free.
 */

export const GATEWAY_KEY_HANDOFF_ENV = "PRSLOY_GATEWAY_KEY";

export type PrsloyHandoff = {
  gatewayKey?: string;
  /** prsloy-harness extensions on every session (`PRSLOY_HARNESS=0` turns them off). */
  harnessEnabled: boolean;
};

export function takePrsloyHandoff(env: NodeJS.ProcessEnv): PrsloyHandoff {
  const gatewayKey = env[GATEWAY_KEY_HANDOFF_ENV]?.trim();
  delete env[GATEWAY_KEY_HANDOFF_ENV];
  return { ...(gatewayKey ? { gatewayKey } : {}), harnessEnabled: env.PRSLOY_HARNESS !== "0" };
}

export const prsloyHandoff: PrsloyHandoff = takePrsloyHandoff(process.env);
