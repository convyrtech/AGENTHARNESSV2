/**
 * The harness's visible cards (pi custom messages `prsloy-harness*`): the budget stop, a
 * project check that still fails, a model that leaked its tool call as text, the second-model
 * review. The harness writes their text for the owner (plain Russian), so the card shows it as
 * is; the short title and line here are only for a card that arrives without text.
 */
import type { MessageKey } from "./i18n.ts";

export type HarnessCardKind = "budget" | "stopGate" | "toolLeak" | "review" | "note";

export function harnessCardKind(customType: string | undefined): HarnessCardKind | undefined {
  if (!customType?.startsWith("prsloy-harness")) return undefined;
  if (customType === "prsloy-harness.budget") return "budget";
  if (customType === "prsloy-harness.stop-gate") return "stopGate";
  if (customType === "prsloy-harness.tool-leak") return "toolLeak";
  if (customType === "prsloy-harness.second-opinion") return "review";
  return "note";
}

/** A data-only entry (the budget's state record) arrives as a JSON block: nothing to show. */
export function isHarnessData(text: string): boolean {
  const body = text.trim();
  return body.startsWith("```json") || body.startsWith("{");
}

export function harnessTitleKey(kind: HarnessCardKind): MessageKey {
  return `harness.${kind}.title`;
}

export function harnessBodyKey(kind: HarnessCardKind): MessageKey | undefined {
  return kind === "note" || kind === "review" ? undefined : `harness.${kind}.body`;
}

/** Every known card's own text is the message; a generic note keeps a title of its own. */
export function harnessUsesOwnText(kind: HarnessCardKind): boolean {
  return kind !== "note";
}

/** The failing check's command and output (`details` of the stop-gate card), for «Подробности». */
export function stopGateOutput(details: unknown): string | undefined {
  const value = details as { command?: unknown; output?: unknown } | null | undefined;
  const output = typeof value?.output === "string" ? value.output.trim() : "";
  if (!output) return undefined;
  return typeof value?.command === "string" && value.command
    ? `$ ${value.command}\n${output}`
    : output;
}

export type ReviewRemark = { where?: string; problem: string };

/** The second opinion's remarks from the card's `details` ({ items: [{ file, line, problem }] }). */
export function reviewRemarks(details: unknown): ReviewRemark[] {
  const items = (details as { items?: unknown } | null | undefined)?.items;
  if (!Array.isArray(items)) return [];
  return items.flatMap((raw) => {
    const item = raw as { file?: unknown; line?: unknown; problem?: unknown };
    if (typeof item.problem !== "string" || !item.problem.trim()) return [];
    const file = typeof item.file === "string" && item.file ? item.file : undefined;
    const line = typeof item.line === "number" ? `:${item.line}` : "";
    return [{ ...(file ? { where: `${file}${line}` } : {}), problem: item.problem.trim() }];
  });
}

/** «Модель сбилась» asks for «Повторить»; the card offers it. */
export function harnessOffersRetry(kind: HarnessCardKind): boolean {
  return kind === "toolLeak";
}
