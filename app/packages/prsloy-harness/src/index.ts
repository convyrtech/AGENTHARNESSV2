// Пакет харнесса PRSLOY: расширение Pi, которое грузится в каждую сессию агента.
// Подключение (дорожка ядра): `new DefaultResourceLoader({ ..., extensionFactories: [createPrsloyHarness()] })`.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installBashTimeout } from "./bash-timeout.ts";
import { installBudget } from "./budget.ts";
import { installEditRobustness } from "./edit-robustness.ts";
import { installLoopDetector } from "./loop-detector.ts";
import { resolveOptions, type HarnessOptions } from "./options.ts";
import { installPostEditVerify } from "./post-edit-verify.ts";
import { installAskUser } from "./ask-user.ts";
import { installFindReady } from "./find-ready.ts";
import { installReliability } from "./reliability.ts";
import { installRequestSecret } from "./request-secret.ts";
import { installSkills } from "./skills.ts";
import { installAutoMemory } from "./memory-auto.ts";
import { installClaimCheck } from "./claim-check.ts";
import { installHonestExit } from "./honest-exit.ts";
import { installTestGuard } from "./test-guard.ts";
import { installVagueRequest } from "./vague-request.ts";
import { installReusePrompt } from "./reuse-prompt.ts";
import { installLessons } from "./lessons.ts";
import { installMemory } from "./memory.ts";
import { installDigest } from "./digest.ts";
import { memoryDirFor } from "./memory-store.ts";
import { installSecretScrub } from "./secret-scrub.ts";
import { installStopGate } from "./stop-gate.ts";
import { checkPage } from "./page-check.ts";
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
export { LEARNING_MAX_BYTES, learningDir, projectKey, recordEvent } from "./learning-log.ts";
export { installReusePrompt } from "./reuse-prompt.ts";
export { MemoryStore, memoryDirFor, MEMORY_LIMITS } from "./memory-store.ts";
// Память вне хода (research/24 M-2, M-3, core): вход экстрактора, сигналы, промпт и проверки.
export { CANDIDATES_FILE, type MemoryEntry, withMemoryLock } from "./memory-store.ts";
export { extractorInput, INPUT_SOURCE_TYPE, type InputSource } from "./memory-input.ts";
export { messageSignals, sessionSignals, type MemorySignalKind } from "./memory-signals.ts";
export {
  checkCandidates,
  extractorPrompt,
  parseExtractorReply,
  type Candidate,
  type ExtractorOp,
} from "./memory-extract.ts";
export { readFlags } from "./flags.ts";
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
    const registry = on("bashTimeout") ? installBashTimeout(pi, opts) : undefined;
    if (on("toolOutput")) installToolOutput(pi, opts);
    if (on("editRobustness")) installEditRobustness(pi, opts);
    if (on("postEditVerify")) installPostEditVerify(pi, opts);
    budget?.installWarning();
    if (on("reusePrompt")) installReusePrompt(pi, opts);
    // После разделов «поиск готового» и «пользователь не программист»: свои разделы идут в порядке установки.
    // Память (S4) — раньше уроков: раздел prsloy_memory идёт перед prsloy_lessons, бюджет у них общий.
    const memory =
      opts.profile === "code" && on("memory")
        ? installMemory(pi, {
            dir: opts.memoryDir ?? memoryDirFor(undefined),
            settingsPath: opts.settingsPath,
          })
        : undefined;
    if (opts.profile === "code" && on("lessons"))
      installLessons(pi, {
        lessonsPath: opts.lessonsPath,
        settingsPath: opts.settingsPath,
        ...(memory ? { memorySection: memory.section } : {}),
      });
    if (on("findReady")) installFindReady(pi, opts, opts.findReady);
    // Вопрос кнопками и ключ формой (research/19 §1.1, §1.3): только «Код».
    if (on("askUser")) installAskUser(pi, opts);
    if (on("requestSecret")) installRequestSecret(pi, opts);
    // Курированные навыки (S9): флаг "skills", по умолчанию выкл.
    if (on("skills")) installSkills(pi, opts, { dir: opts.skillsDir });
    // Раньше стоп-гейта: сорванный вызов инструмента — сначала повтор, проверки проекта потом.
    if (on("toolLeak")) installToolLeak(pi);
    if (codeGate)
      installStopGate(pi, opts, {
        ...(changes ? { changes } : {}),
        ...(budget ? { budget } : {}),
        ...(on("pagePaths") ? {} : { pagePaths: false as const }),
        pageCheck: on("pageCheck") ? (cwd: string) => checkPage(cwd, opts.pageCheck) : false,
        ...(on("secondOpinion")
          ? {
              reviewer: modelReviewer(opts.review),
              reviewEnabled: secondOpinionFlag(opts.settingsPath),
            }
          : {}),
      });
    // После стоп-гейта: расплывчатая просьба без названного прочтения — один раз «допиши, как понял» (этап 14).
    if (on("vagueRequest")) installVagueRequest(pi, opts);
    // Сводка «прошлый раз» (S6): после стоп-гейта — его итог хода уже известен.
    if (memory && on("digest"))
      installDigest(pi, {
        store: memory.store,
        changes,
        servers: registry ? () => registry.list() : undefined,
        settingsPath: opts.settingsPath,
      });
    // Трубы research/24 §2: точки подключения памяти «сама» (core), честного выхода, стража тестов и сверки слов
    // (harness). Пока пустые; поведение — за флагами autoMemory / honestExit / testGuard / claimCheck.
    // Страж и сверка — рядом со стоп-гейтом (им нужен снимок хода), до чистки секретов.
    if (opts.profile === "code") {
      if (on("autoMemory")) installAutoMemory(pi, opts);
      if (on("honestExit")) installHonestExit(pi, opts);
      if (on("testGuard")) installTestGuard(pi, opts);
      if (on("claimCheck")) installClaimCheck(pi, opts);
    }
    if (on("secretScrub")) installSecretScrub(pi);
    if (on("reliabilityProxy")) installReliability(pi, opts);
  };
}

/** Точка входа для загрузчика с настройками по умолчанию. */
export function register(pi: ExtensionAPI): void {
  createPrsloyHarness()(pi);
}

export default register;
