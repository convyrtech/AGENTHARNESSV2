// Пакет харнесса PRSLOY: расширение Pi, которое грузится в каждую сессию агента.
// Подключение (дорожка ядра): `new DefaultResourceLoader({ ..., extensionFactories: [createPrsloyHarness()] })`.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installBashTimeout } from "./bash-timeout.ts";
import { installBudget } from "./budget.ts";
import { installEditRobustness } from "./edit-robustness.ts";
import { installLoopDetector } from "./loop-detector.ts";
import { resolveOptions, type HarnessOptions } from "./options.ts";
import { installPostEditVerify } from "./post-edit-verify.ts";
import { installFindReady } from "./find-ready.ts";
import { installReliability } from "./reliability.ts";
import { installReusePrompt } from "./reuse-prompt.ts";
import { installLessons } from "./lessons.ts";
import { installSecretScrub } from "./secret-scrub.ts";
import { installStopGate } from "./stop-gate.ts";
import { installArgRepair } from "./arg-repair.ts";
import { configureLearning, installLearningLog } from "./learning-log.ts";
import { installToolLeak } from "./tool-leak.ts";
import { installToolOutput } from "./tool-output.ts";
import { modelReviewer, secondOpinionFlag } from "./reviewer.ts";
import { gitResolver, installTurnChanges, TurnChanges } from "./turn-changes.ts";
import { join } from "node:path";

export type { HarnessOptions, HarnessProfile, PracticeName } from "./options.ts";
export { sanitizedEnv } from "./options.ts";
export { checkFile } from "./checkers.ts";
export { FindReady, formatResult as formatFindReady } from "./find-ready.ts";
export { detectPseudoToolCall } from "./loop-detector.ts";
export { scrubSecrets } from "./secret-scrub.ts";
export { repairToolCall } from "./arg-repair.ts";
export { harnessStats } from "./stats.ts";
export { learningDir, recordEvent } from "./learning-log.ts";
export { installReusePrompt } from "./reuse-prompt.ts";
export { detectToolLeak, stripToolMarkup } from "./tool-leak.ts";
export {
  evidenceInDiff,
  parseVerdict,
  reviewerFor,
  reviewPrompt,
  clipDiff,
  REVIEW_PASS_CARD,
  reviewFailCard,
} from "./second-opinion.ts";
export { looksLikeServer, detectPorts } from "./process-registry.ts";
export { resolveToolPath } from "./paths.ts";
export {
  ReliabilityProxy,
  STREAM_INTERRUPTED_CODE,
  STREAM_INTERRUPTED_MESSAGE,
  type ReliabilityOptions,
} from "./reliability-proxy.ts";

/**
 * Порядок важен. tool_call: бюджет и петли блокируют до того, как bash что-то запустит.
 * tool_result идут цепочкой в том же порядке; предупреждение бюджета — после обрезки вывода,
 * секреты — последними, чтобы чистить итоговый текст.
 */
export function createPrsloyHarness(options: HarnessOptions = {}): (pi: ExtensionAPI) => void {
  return (pi: ExtensionAPI) => {
    const opts = resolveOptions(options);
    const on = (name: keyof typeof opts.disable) => !opts.disable[name];
    // Журнал событий для уроков (S0): первым, чтобы видеть все вызовы хода. Поведение не меняет.
    configureLearning({
      enabled: on("learningLog"),
      ...(opts.learningDir ? { dir: opts.learningDir } : {}),
    });
    if (on("learningLog")) installLearningLog(pi);
    // Самым первым: вызовы с битыми аргументами чинятся до валидации Pi и до всех хуков ниже.
    if (on("argRepair")) installArgRepair(pi);
    const codeGate = opts.profile === "code" && on("stopGate");
    // Первым: снимок начала хода ложится до того, как bash или фоновый процесс что-то поменяют.
    const changes =
      codeGate && on("turnChanges")
        ? new TurnChanges(join(opts.outputDir, "turns"), gitResolver(pi, opts.gitPath))
        : undefined;
    if (changes) installTurnChanges(pi, changes);
    const budget = on("budget") ? installBudget(pi, opts) : undefined;
    if (on("loopDetector")) installLoopDetector(pi, opts);
    if (on("bashTimeout")) installBashTimeout(pi, opts);
    if (on("toolOutput")) installToolOutput(pi, opts);
    if (on("editRobustness")) installEditRobustness(pi, opts);
    if (on("postEditVerify")) installPostEditVerify(pi, opts);
    budget?.installWarning();
    if (on("reusePrompt")) installReusePrompt(pi, opts);
    // После разделов «поиск готового» и «пользователь не программист»: свои разделы идут в порядке установки.
    if (opts.profile === "code" && on("lessons"))
      installLessons(pi, { lessonsPath: opts.lessonsPath, settingsPath: opts.settingsPath });
    if (on("findReady")) installFindReady(pi, opts, opts.findReady);
    // Раньше стоп-гейта: сорванный вызов инструмента — сначала повтор, проверки проекта потом.
    if (on("toolLeak")) installToolLeak(pi);
    if (codeGate)
      installStopGate(pi, opts, {
        ...(changes ? { changes } : {}),
        ...(budget ? { budget } : {}),
        ...(on("secondOpinion")
          ? {
              reviewer: modelReviewer(opts.review),
              reviewEnabled: secondOpinionFlag(opts.settingsPath),
            }
          : {}),
      });
    if (on("secretScrub")) installSecretScrub(pi);
    if (on("reliabilityProxy")) installReliability(pi, opts);
  };
}

/** Точка входа для загрузчика с настройками по умолчанию. */
export function register(pi: ExtensionAPI): void {
  createPrsloyHarness()(pi);
}

export default register;
