/**
 * The gateway key and the search config main hands over. They come as the first parentPort
 * message (`prsloy.handoff`, shared/host-handoff.ts) — not the spawn env, whose original block a
 * child reads from /proc/<ppid>/environ on Linux even after a delete. The env names are still
 * taken and deleted at boot in case an old main or a developer sets them by hand.
 *
 * Imported for its side effect before the runtime; keep it dependency-free.
 */
import { type HostHandoffMessage, parseSearchHandoff } from "../shared/host-handoff.ts";

export const GATEWAY_KEY_HANDOFF_ENV = "PRSLOY_GATEWAY_KEY";
/** Web search provider and key (issue #23): JSON from main, taken and deleted the same way. */
export const SEARCH_HANDOFF_ENV = "PRSLOY_SEARCH_HANDOFF";

export type { HostSearchHandoff as SearchHandoff } from "../shared/host-handoff.ts";
type SearchHandoff = NonNullable<HostHandoffMessage["search"]>;

export type PrsloyHandoff = {
  gatewayKey?: string;
  search?: SearchHandoff;
  /** prsloy-harness extensions on every session (`PRSLOY_HARNESS=0` turns them off). */
  harnessEnabled: boolean;
};

export function takePrsloyHandoff(env: NodeJS.ProcessEnv): PrsloyHandoff {
  const gatewayKey = env[GATEWAY_KEY_HANDOFF_ENV]?.trim();
  delete env[GATEWAY_KEY_HANDOFF_ENV];
  const search = parseSearchHandoff(env[SEARCH_HANDOFF_ENV]);
  delete env[SEARCH_HANDOFF_ENV];
  return {
    ...(gatewayKey ? { gatewayKey } : {}),
    ...(search ? { search } : {}),
    harnessEnabled: env.PRSLOY_HARNESS !== "0",
  };
}

export const prsloyHandoff: PrsloyHandoff = takePrsloyHandoff(process.env);

/** The parentPort message from main: what it carries wins over anything the env had. */
export function applyHostHandoff(target: PrsloyHandoff, message: HostHandoffMessage): void {
  if (message.gatewayKey?.trim()) target.gatewayKey = message.gatewayKey.trim();
  if (message.search) target.search = message.search;
}
