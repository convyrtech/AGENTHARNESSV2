/**
 * Finds the agent host that owns a runtime — the foreground one, or a chat parked in the
 * background. Kept out of `main/index.ts` (over its line budget) so the routing rule is
 * one small, testable function.
 *
 * #83: an answer used to be accepted only from the foreground host, so switching chats
 * while a question was open got the answer rejected as «stale» and the agent waited
 * forever. The runtime id says which host asked, so it can be found either way.
 */
export type RuntimeHostLike<H> = { snapshot: { runtimeId: string }; host: H };

export function findHostForRuntime<H extends { ignoreMessages: boolean }>(input: {
  foreground?: { runtimeId: string | undefined; host: H | undefined };
  parked: Iterable<RuntimeHostLike<H>>;
  runtimeId: string;
}): H | undefined {
  if (input.foreground?.host && input.foreground.runtimeId === input.runtimeId) {
    return input.foreground.host;
  }
  for (const entry of input.parked) {
    if (entry.snapshot.runtimeId === input.runtimeId) return entry.host;
  }
  return undefined;
}
