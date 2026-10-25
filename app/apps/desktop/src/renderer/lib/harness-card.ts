/**
 * The harness's visible cards (pi custom messages `prsloy-harness*`): the budget stop, a
 * project check that still fails, a model that leaked its tool call as text. Their raw text is
 * written for the record (limits, check output); the owner gets a plain title and one line.
 */
import type { MessageKey } from "./i18n.ts";

export type HarnessCardKind = "budget" | "stopGate" | "toolLeak" | "note";

export function harnessCardKind(customType: string | undefined): HarnessCardKind | undefined {
  if (!customType?.startsWith("prsloy-harness")) return undefined;
  if (customType === "prsloy-harness.budget") return "budget";
  if (customType === "prsloy-harness.stop-gate") return "stopGate";
  if (customType === "prsloy-harness.tool-leak") return "toolLeak";
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
  return kind === "note" ? undefined : `harness.${kind}.body`;
}

/** «Модель сбилась» asks for «Повторить»; the card offers it. */
export function harnessOffersRetry(kind: HarnessCardKind): boolean {
  return kind === "toolLeak";
}
