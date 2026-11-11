import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { differentModelFamilies, modelFamily } from "./delegation-policy.ts";
import type { ExploreModel } from "./explore.ts";

const namedWorker = [
  /^пусть\s+(?:агент\s+)?(?:кими|kimi)\s+(?:сделает|исправит|напишет|реализует|внес[её]т)(?!\p{L})/iu,
  /^(?:поручи|передай|делегируй|отдай|дай)\s+(?:эту\s+)?(?:задачу|правку|работу)\s+(?:кими|kimi)(?![\p{L}\p{N}_])/iu,
  /^(?:поручи|попроси|дай)\s+(?:кими|kimi)\s+(?:исправить|сделать|написать|реализовать|внести)(?!\p{L})/iu,
  /^(?:кими|kimi)\s*,\s*(?:исправь|сделай|напиши|реализуй|внеси)(?!\p{L})/iu,
  /^kimi\s*,\s*(?:fix|implement|write|make|apply)\b/i,
  /^(?:ask|have|let)\s+kimi\s+(?:to\s+)?(?:fix|implement|write|make|apply)\b/i,
];

export function asksKimiToImplement(prompt: string): boolean {
  const prose = prompt
    .replace(/^```[^\n]*\n[\s\S]*?(?:^```[^\n]*$|$)/gm, "")
    .replace(/^\s*>.*$/gm, "")
    .replace(/«[^»]*»|“[^”]*”|`[^`]*`/gu, "");
  return prose.split(/[.!?\n]/).some((clause) => {
    const instruction = clause.trim().replace(/^пожалуйста[, ]+/i, "");
    return namedWorker.some((pattern) => pattern.test(instruction));
  });
}

export function explicitKimiModels(ctx: ExtensionContext): {
  workerModel: string;
  reviewerModel: string;
} {
  const ref = (model: ExploreModel) => `${model.provider}/${model.id}`;
  const allowed = new Set(ctx.scopedModels.map(({ model }) => ref(model)));
  const available = ctx.modelRegistry
    .getAvailable()
    .filter(
      (model) => model.api === "openai-completions" && (!allowed.size || allowed.has(ref(model))),
    );
  const kimi = available.filter((model) => modelFamily(ref(model)) === "kimi");
  const worker =
    kimi.find((model) => model.provider === ctx.model?.provider && model.id === "kimi-k3.1-pro") ??
    kimi.find((model) => model.provider === ctx.model?.provider) ??
    kimi.find((model) => model.id === "kimi-k3.1-pro") ??
    kimi[0];
  if (!worker) throw new Error("Requested Kimi executor is unavailable");
  const reviewers = available.filter((model) => differentModelFamilies(ref(worker), ref(model)));
  const reviewer =
    reviewers.find(
      (model) => model.provider === worker.provider && model.id === "minimax-m3.1-flash",
    ) ??
    reviewers.find((model) => ctx.model && ref(model) === ref(ctx.model)) ??
    reviewers.find((model) => model.provider === worker.provider) ??
    reviewers[0];
  if (!reviewer) throw new Error("An available reviewer from a different model family is required");
  return { workerModel: ref(worker), reviewerModel: ref(reviewer) };
}
