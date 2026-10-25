// Флаги приложения из `$PI_CODING_AGENT_DIR/prsloy-harness.json` (research/18 §6.2): читаются при каждом
// обращении — приложение меняет их без перезапуска хоста. Битый или отсутствующий файл — всё по умолчанию.
import { existsSync, readFileSync } from "node:fs";

export interface HarnessFlags {
  secondOpinion: boolean;
  /** «Учитывать опыт прошлых задач» (уроки). */
  lessons: boolean;
  /** Курированные навыки (S9, research/18). По умолчанию выкл. — включается по замеру. */
  skills: boolean;
  /** Уроки, выключенные вручную (срочный откат, §7.6). */
  disabledLessons: string[];
  /** «Запоминать, когда я прошу» (память, S4). По умолчанию выкл., пока в приложении нет «Забыть» и панели «Память» (S5). */
  memory: boolean;
  /**
   * Системный промпт «Кода»: базовый Pi + разделы (pi), свой (prsloy, research/17 §9) или диета (diet, H-1p #6:
   * ≤4 000 знаков, правила кода и процедуры — вон). По умолчанию prsloy (этап 14, A/B: 11/12 против 10/12).
   */
  prompt: "pi" | "prsloy" | "diet";
  /** Дельта под модель (prsloy_model, research/17 §9.1). По умолчанию выкл. */
  promptDelta: boolean;
  /**
   * Память сама, из слов пользователя (research/24 §3, core): "off" — нет; "shadow" — экстрактор пишет только
   * кандидатов, в промпт ничего; true — записывает. По умолчанию "off".
   */
  autoMemory: AutoMemoryMode;
  /** Честный выход (research/24 §4.2): инструмент report_blocker и текст T1 в возвратах. По умолчанию выкл. */
  honestExit: boolean;
  /** Страж старых тестов (research/24 §4.1, H2/H3). По умолчанию выкл. до ответа владельца (§4.3). */
  testGuard: boolean;
  /** Сверка слов агента с вызовами (research/24 §4.1, H-2: «проверил», заглушки). По умолчанию выкл. */
  claimCheck: boolean;
  /** web_search и web_fetch в обычных ходах «Кода» (issue #23, research/26 §4). По умолчанию выкл. до замера. */
  webTools: boolean;
  /** Полезность новых тестов (H-3, #8): сигналы ревьюеру и в статус хода. По умолчанию выкл. */
  testQuality: boolean;
  /** Ревьюер ищет подгонку (H-4, #9): виды подгонки в промпте, факты кодом, тесты в диффе целиком. По умолчанию выкл. */
  reviewerCheats: boolean;
}

export type AutoMemoryMode = "off" | "shadow" | true;

export function readFlags(settingsPath: string | undefined): HarnessFlags {
  const flags: HarnessFlags = {
    secondOpinion: true,
    lessons: true,
    skills: false,
    disabledLessons: [],
    // MVP (25.10, owner): memory, auto memory and web tools on by default; an explicit false / "off" in the
    // file stays.
    memory: true,
    prompt: "prsloy",
    promptDelta: false,
    autoMemory: true,
    honestExit: false,
    testGuard: false,
    claimCheck: false,
    webTools: true,
    testQuality: false,
    reviewerCheats: false,
  };
  if (settingsPath && existsSync(settingsPath)) {
    try {
      const raw = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
      if (raw.secondOpinion === false) flags.secondOpinion = false;
      if (raw.lessons === false) flags.lessons = false;
      if (raw.skills === true) flags.skills = true;
      if (typeof raw.memory === "boolean") flags.memory = raw.memory;
      if (raw.prompt === "prsloy" || raw.prompt === "pi" || raw.prompt === "diet")
        flags.prompt = raw.prompt;
      if (raw.promptDelta === true) flags.promptDelta = true;
      if (raw.autoMemory === true || raw.autoMemory === "shadow" || raw.autoMemory === "off")
        flags.autoMemory = raw.autoMemory;
      if (raw.honestExit === true) flags.honestExit = true;
      if (raw.testGuard === true) flags.testGuard = true;
      if (raw.claimCheck === true) flags.claimCheck = true;
      if (typeof raw.webTools === "boolean") flags.webTools = raw.webTools;
      if (raw.testQuality === true) flags.testQuality = true;
      if (raw.reviewerCheats === true) flags.reviewerCheats = true;
      if (Array.isArray(raw.disabledLessons))
        flags.disabledLessons = raw.disabledLessons.filter(
          (x): x is string => typeof x === "string",
        );
    } catch {
      // битый файл — по умолчанию
    }
  }
  if (process.env.PRSLOY_SECOND_OPINION === "0") flags.secondOpinion = false;
  if (process.env.PRSLOY_LESSONS === "0") flags.lessons = false;
  if (process.env.PRSLOY_SKILLS === "1") flags.skills = true;
  if (process.env.PRSLOY_SKILLS === "0") flags.skills = false;
  if (process.env.PRSLOY_MEMORY === "1") flags.memory = true;
  if (process.env.PRSLOY_MEMORY === "0") flags.memory = false;
  const prompt = process.env.PRSLOY_PROMPT;
  if (prompt === "prsloy" || prompt === "pi" || prompt === "diet") flags.prompt = prompt;
  if (process.env.PRSLOY_PROMPT_DELTA === "1") flags.promptDelta = true;
  const auto = process.env.PRSLOY_AUTO_MEMORY;
  if (auto === "1" || auto === "on") flags.autoMemory = true;
  else if (auto === "shadow" || auto === "off") flags.autoMemory = auto;
  for (const [env, key] of [
    ["PRSLOY_HONEST_EXIT", "honestExit"],
    ["PRSLOY_TEST_GUARD", "testGuard"],
    ["PRSLOY_CLAIM_CHECK", "claimCheck"],
    ["PRSLOY_WEB_TOOLS", "webTools"],
    ["PRSLOY_TEST_QUALITY", "testQuality"],
    ["PRSLOY_REVIEWER_CHEATS", "reviewerCheats"],
  ] as const) {
    if (process.env[env] === "1") flags[key] = true;
    if (process.env[env] === "0") flags[key] = false;
  }
  return flags;
}
