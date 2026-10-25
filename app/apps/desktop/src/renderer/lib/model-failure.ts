/**
 * A failed model turn, in words a casual owner understands, with one thing to do about it.
 *
 * The host sends a stable `code` with `message.failed` (agent-runtime `classifyModelError`).
 * A chat reopened from disk has only pi's raw error text, so the same few cases are read
 * from that text as a fallback.
 */
import type { MessageKey } from "./i18n.ts";
import { RESPONSE_FAILED_TITLE } from "./system-notices.ts";

export type FailureKind = "network" | "balance" | "key" | "model" | "busy" | "slow" | "server";

/** What the card's one button does. */
export type FailureAction = "retry" | "topUp" | "changeKey";

const MODEL_MISSING =
  /model_not_found|model[^\n]{0,60}(does not exist|not found|not available|unavailable|unsupported)|no such model/iu;

/** The reliability proxy gave up after attempts that each lost the connection: a drop, not a 502. */
const PROXY_DROPS =
  /attempts failed[\s\S]*(fetch failed|ECONNRESET|socket hang up|terminated|other side closed)/iu;

export function failureKind(code: string | undefined, text: string): FailureKind {
  if (PROXY_DROPS.test(text)) return "network";
  switch (code) {
    case "model_unavailable":
      return "model";
    case "no_balance":
      return "balance";
    case "auth":
      return "key";
    case "rate_limit":
      return "busy";
    case "timeout":
      return "slow";
    case "server":
      return "server";
    case "network":
      return "network";
    default:
      break;
  }
  // No code (a chat reopened from disk keeps only pi's text) or `unknown`: read the text.
  if (MODEL_MISSING.test(text)) return "model";
  const raw = text.trim();
  if (/^402\b|insufficient (balance|funds|quota)|out of credits/iu.test(raw)) return "balance";
  if (/^40[13]\b|invalid api key|unauthori[sz]ed/iu.test(raw)) return "key";
  if (/^429\b|rate.?limit|too many requests/iu.test(raw)) return "busy";
  if (/^(408|504)\b|timed? ?out|timeout/iu.test(raw)) return "slow";
  if (/^5\d\d\b|overloaded|bad gateway|service unavailable/iu.test(raw)) return "server";
  return "network";
}

export function failureTitleKey(kind: FailureKind): MessageKey {
  return `failure.${kind}.title`;
}

/** A short second line only where the title alone does not say what to do. */
export function failureHintKey(kind: FailureKind): MessageKey | undefined {
  return kind === "model" || kind === "busy" ? `failure.${kind}.hint` : undefined;
}

export function failureAction(kind: FailureKind): FailureAction {
  if (kind === "balance") return "topUp";
  if (kind === "key") return "changeKey";
  return "retry";
}

export function failureActionKey(action: FailureAction): MessageKey {
  return action === "topUp"
    ? "failure.action.topUp"
    : action === "changeKey"
      ? "failure.action.changeKey"
      : "system.retry.action";
}

type Item = { kind: string; title?: string; tone?: string; attempt?: number };

const isRetryNote = (item: Item) => item.kind === "system" && item.title === "Retry";
const isFailure = (item: Item) =>
  item.kind === "system" && item.tone === "error" && item.title === RESPONSE_FAILED_TITLE;

/**
 * Casual timeline: pi's automatic retries are one quiet line, not a stack of error cards.
 * Within a turn, a failure that a retry followed is dropped (the retry superseded it), the
 * «retry gave up» note is dropped (the final failure card says it), and a «trying again»
 * line stays only while it is the turn's latest row.
 */
export function withoutRetryNoise<T extends Item>(items: readonly T[]): T[] {
  const out: T[] = [];
  items.forEach((item, index) => {
    if (!isRetryNote(item) && !isFailure(item)) {
      out.push(item);
      return;
    }
    let next = index + 1;
    while (next < items.length && items[next]?.kind !== "user") {
      if (isFailure(item) && isRetryNote(items[next]!) && items[next]!.attempt !== undefined) {
        return;
      }
      next++;
    }
    if (isRetryNote(item)) {
      const last = next === index + 1;
      if (item.attempt === undefined || !last) return;
    }
    out.push(item);
  });
  return out;
}
