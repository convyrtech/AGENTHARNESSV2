import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { recordEvent } from "./learning-log.ts";

/**
 * A continuation is a fresh model request.  Several independent boundary
 * hooks can request one for the same user message, so their local retry caps
 * do not provide a global bound.  Keep this below the normal tool budget and
 * stop only the automatic chain; this does not change provider max_tokens.
 */
export const MAX_AUTO_CONTINUATIONS = 8;
const GUARD_NOTE =
  "Автоматическая цепочка проверок остановлена после нескольких повторных ходов. " +
  "Остановись и сообщи текущий результат пользователю.";

export function installContinuationGuard(pi: ExtensionAPI): void {
  let continuations = 0;

  pi.on("before_agent_start", (event) => {
    if (event.messageType === "user") continuations = 0;
  });

  // Install this last: event.continue is the aggregate result of all earlier
  // agent_before_settle handlers in Pi's extension runner.
  pi.on("agent_before_settle", (event, ctx) => {
    if (!event.continue) return undefined;
    continuations += 1;
    if (continuations <= MAX_AUTO_CONTINUATIONS) return undefined;
    recordEvent(ctx, { kind: "continuation.guard", n: continuations });
    return {
      entries: [
        ...event.entries,
        {
          type: "custom_message",
          customType: "prsloy-harness.continuation-guard",
          content: GUARD_NOTE,
          display: false,
        },
      ],
      continue: false,
    };
  });
}
