import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { recordEvent } from "./learning-log.ts";

/**
 * A continuation is a fresh model request.  Several independent boundary
 * hooks can request one for the same user message, so their local retry caps
 * do not provide a global bound.  Keep this below the normal tool budget and
 * stop only the automatic chain; this does not change provider max_tokens.
 */
export const MAX_AUTO_CONTINUATIONS = 8;
/** One automatic summary is enough for a user turn. A second summary is itself
 * another large model request and can form a compaction/continuation storm. */
export const MAX_AUTO_COMPACTIONS = 1;
const GUARD_NOTE =
  "Автоматическая цепочка проверок остановлена после нескольких повторных ходов. " +
  "Остановись и сообщи текущий результат пользователю.";

function localCompaction(event: any): { compaction: Record<string, unknown> } {
  const preparation = event.preparation;
  const previous =
    typeof preparation?.previousSummary === "string"
      ? preparation.previousSummary.slice(-8_000)
      : "";
  const summary = [
    "PRSLOY local compaction: the older context was compacted without another model request.",
    previous ? `Previous summary:\n${previous}` : "",
    "Recent messages are retained after firstKeptEntryId. Continue from the retained context and the task-thread facts.",
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    compaction: {
      summary,
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
    },
  };
}

export function installContinuationGuard(pi: ExtensionAPI): void {
  let continuations = 0;
  let compactions = 0;
  let compactionBlocked = false;

  pi.on("before_agent_start", (event) => {
    if (event.messageType === "user") {
      continuations = 0;
      compactions = 0;
      compactionBlocked = false;
    }
  });

  // Pi generates the compaction summary with the active model. Allowing a
  // second automatic summary in one turn means paying for another 500k-token
  // request before the next continuation can even start.
  // Pi 1.4 supports this event at runtime; older published typings omitted it.
  (pi as any).on("session_before_compact", (event: any) => {
    if (event.reason !== "threshold" && event.reason !== "overflow") return undefined;
    if (compactions < MAX_AUTO_COMPACTIONS) {
      compactions += 1;
      return localCompaction(event);
    }
    compactionBlocked = true;
    return { cancel: true };
  });

  // Install this last: event.continue is the aggregate result of all earlier
  // agent_before_settle handlers in Pi's extension runner.
  pi.on("agent_before_settle", (event, ctx) => {
    if (compactionBlocked) {
      compactionBlocked = false;
      recordEvent(ctx, { kind: "continuation.guard", n: compactions + 1 });
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
    }
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
