// Флаги приложения из `$PI_CODING_AGENT_DIR/prsloy-harness.json` (research/18 §6.2): читаются при каждом
// обращении — приложение меняет их без перезапуска хоста. Битый или отсутствующий файл — всё по умолчанию.
import { existsSync, readFileSync } from "node:fs";

export interface HarnessFlags {
  secondOpinion: boolean;
  /** «Учитывать опыт прошлых задач» (уроки). */
  lessons: boolean;
  /** Уроки, выключенные вручную (срочный откат, §7.6). */
  disabledLessons: string[];
  /** «Запоминать, когда я прошу» (память, S4). По умолчанию выкл., пока в приложении нет «Забыть» и панели «Память» (S5). */
  memory: boolean;
  /** Системный промпт «Кода»: базовый Pi + разделы (pi) или свой (prsloy, research/17 §9). По умолчанию pi. */
  prompt: "pi" | "prsloy";
  /** Дельта под модель (prsloy_model, research/17 §9.1). По умолчанию выкл. */
  promptDelta: boolean;
}

export function readFlags(settingsPath: string | undefined): HarnessFlags {
  const flags: HarnessFlags = {
    secondOpinion: true,
    lessons: true,
    disabledLessons: [],
    memory: false,
    prompt: "pi",
    promptDelta: false,
  };
  if (settingsPath && existsSync(settingsPath)) {
    try {
      const raw = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
      if (raw.secondOpinion === false) flags.secondOpinion = false;
      if (raw.lessons === false) flags.lessons = false;
      if (raw.memory === true) flags.memory = true;
      if (raw.prompt === "prsloy") flags.prompt = "prsloy";
      if (raw.promptDelta === true) flags.promptDelta = true;
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
  if (process.env.PRSLOY_MEMORY === "1") flags.memory = true;
  if (process.env.PRSLOY_MEMORY === "0") flags.memory = false;
  if (process.env.PRSLOY_PROMPT === "prsloy" || process.env.PRSLOY_PROMPT === "pi")
    flags.prompt = process.env.PRSLOY_PROMPT;
  if (process.env.PRSLOY_PROMPT_DELTA === "1") flags.promptDelta = true;
  return flags;
}
