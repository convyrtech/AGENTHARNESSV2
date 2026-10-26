/**
 * The turn's outcome from facts, not from the model's words (#10, research/24 §4.4–4.5): the
 * harness checks what happened (H-2, #7) and sends one card per turn, `prsloy-harness.turn-status`
 * with `details.facts`. The model cannot write or cover it. When the checks are red the card stands
 * above the model's reply and the turn's header no longer says «Готово».
 *
 * Contract (proposed to harness #7): details = { facts: TurnFact[], files?: string[] }, where
 * `files` are the stubs left or the old tests changed; content = the same in plain Russian.
 */
import type { MessageKey } from "./i18n.ts";
import { isHostCrash, isModelFailure } from "./system-notices.ts";
import type { TimelineBlock, TimelineItem } from "./timeline.ts";

export const TURN_STATUS_TYPE = "prsloy-harness.turn-status";

export type TurnFact =
  | "checks-fail"
  | "page-fail"
  | "ran-fail"
  | "stubs-left"
  | "claim-unbacked"
  | "tests-changed"
  | "tests-weak"
  | "page-hints"
  | "checks-pass"
  | "page-ok"
  | "ran-ok"
  | "tests-updated"
  | "no-checks";

/** Display order: what needs the owner first. */
const ORDER: readonly TurnFact[] = [
  "checks-fail",
  "page-fail",
  "ran-fail",
  "stubs-left",
  "claim-unbacked",
  "tests-changed",
  "tests-weak",
  "page-hints",
  "checks-pass",
  "page-ok",
  "ran-ok",
  "tests-updated",
  "no-checks",
];

export type TurnTone = "fail" | "warn" | "ok" | "neutral";

/** `page`: up to 3 findings of harness's page check («кнопка .cta: не нажимается»), shown like files. */
export type TurnClaim = { quote: string; why?: string };

/** `claims`: up to 2 of the agent's words a check did not back (harness claimCheck), shown like files. */
export type TurnStatus = {
  facts: TurnFact[];
  tone: TurnTone;
  files: string[];
  page: string[];
  claims: TurnClaim[];
};

export function parseTurnStatus(details: unknown): TurnStatus | undefined {
  const value = details as
    | { facts?: unknown; files?: unknown; page?: unknown; claims?: unknown }
    | null
    | undefined;
  if (!Array.isArray(value?.facts)) return undefined;
  const given = new Set(value.facts.filter((f): f is TurnFact => ORDER.includes(f as TurnFact)));
  // red wins over a stale green from the same turn
  if (given.has("checks-fail")) given.delete("checks-pass");
  if (given.has("page-fail")) given.delete("page-ok");
  if (given.has("ran-fail")) given.delete("ran-ok");
  const facts = ORDER.filter((f) => given.has(f));
  if (facts.length === 0) return undefined;
  const files = Array.isArray(value.files)
    ? value.files.filter((f): f is string => typeof f === "string" && f.length > 0)
    : [];
  const page = Array.isArray(value.page)
    ? value.page
        .filter((f): f is string => typeof f === "string" && f.trim().length > 0)
        .slice(0, 3)
    : [];
  const claims = Array.isArray(value.claims)
    ? value.claims
        .flatMap((raw): TurnClaim[] => {
          const claim = raw as { quote?: unknown; why?: unknown } | null;
          const quote = typeof claim?.quote === "string" ? claim.quote.trim() : "";
          if (!quote) return [];
          const why = typeof claim?.why === "string" ? claim.why.trim() : "";
          return [why ? { quote, why } : { quote }];
        })
        .slice(0, 2)
    : [];
  return { facts, tone: turnTone(facts), files, page, claims };
}

export function turnTone(facts: readonly TurnFact[]): TurnTone {
  if (facts.some((f) => f === "checks-fail" || f === "page-fail" || f === "ran-fail"))
    return "fail";
  const warn: readonly TurnFact[] = ["stubs-left", "claim-unbacked", "tests-changed", "tests-weak"];
  if (facts.some((f) => warn.includes(f))) return "warn";
  if (facts.some((f) => f === "checks-pass" || f === "page-ok" || f === "ran-ok")) return "ok";
  return "neutral";
}

export function turnFactKey(fact: TurnFact): MessageKey {
  return `turnStatus.${fact}`;
}

type SystemItem = Extract<TimelineItem, { kind: "system" }>;

export function isTurnStatusItem(item: TimelineItem): boolean {
  return item.kind === "system" && item.extension === true && item.title === TURN_STATUS_TYPE;
}

/**
 * A red turn: its status card moves right above the model's final reply, and the turn's process
 * header is marked so it says how long the agent worked instead of «Готово». Other turns keep the
 * card where it came (a line under the reply).
 */
export function arrangeTurnStatus(blocks: readonly TimelineBlock[]): TimelineBlock[] {
  const out = [...blocks];
  let turnStart = 0;
  for (let i = 0; i <= out.length; i++) {
    const block = out[i];
    const turnEnds = i === out.length || (block?.type === "item" && block.item.kind === "user");
    if (!turnEnds) continue;
    redTurn(out, turnStart, i);
    stoppedTurn(out, turnStart, i);
    turnStart = i + 1;
  }
  return out;
}

/** A turn the model broke off (402, a dropped connection, a crashed host) is not «Готово» either. */
function stoppedTurn(blocks: TimelineBlock[], from: number, to: number) {
  const failed = blocks
    .slice(from, to)
    .some(
      (block) =>
        block.type === "item" &&
        block.item.kind === "system" &&
        (isModelFailure(block.item) || isHostCrash(block.item)),
    );
  if (!failed) return;
  for (let i = from; i < to; i++) {
    const block = blocks[i]!;
    if (block.type === "process") blocks[i] = { ...block, stopped: true };
  }
}

function redTurn(blocks: TimelineBlock[], from: number, to: number) {
  let statusAt = -1;
  for (let i = to - 1; i >= from; i--) {
    const block = blocks[i]!;
    if (block.type === "item" && isTurnStatusItem(block.item)) {
      statusAt = i;
      break;
    }
  }
  if (statusAt < 0) return;
  const status = blocks[statusAt] as Extract<TimelineBlock, { type: "item" }>;
  if (parseTurnStatus((status.item as SystemItem).details)?.tone !== "fail") return;
  for (let i = from; i < to; i++) {
    const block = blocks[i]!;
    if (block.type === "process") blocks[i] = { ...block, checksFailed: true };
  }
  let replyAt = -1;
  for (let i = statusAt - 1; i >= from; i--) {
    const block = blocks[i]!;
    if (block.type === "item" && block.item.kind === "assistant") {
      replyAt = i;
      break;
    }
  }
  if (replyAt < 0) return;
  blocks.splice(statusAt, 1);
  blocks.splice(replyAt, 0, status);
}
