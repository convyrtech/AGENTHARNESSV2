// Флаги приложения из `$PI_CODING_AGENT_DIR/prsloy-harness.json` (research/18 §6.2): читаются при каждом
// обращении — приложение меняет их без перезапуска хоста. Битый или отсутствующий файл — всё по умолчанию.
import { existsSync, readFileSync } from "node:fs";

export interface HarnessFlags {
  secondOpinion: boolean;
  /** «Учитывать опыт прошлых задач» (уроки). */
  lessons: boolean;
  /** Уроки, выключенные вручную (срочный откат, §7.6). */
  disabledLessons: string[];
  /** «Запоминать, когда я прошу» (память, S4). */
  memory: boolean;
}

export function readFlags(settingsPath: string | undefined): HarnessFlags {
  const flags: HarnessFlags = {
    secondOpinion: true,
    lessons: true,
    disabledLessons: [],
    memory: true,
  };
  if (settingsPath && existsSync(settingsPath)) {
    try {
      const raw = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
      if (raw.secondOpinion === false) flags.secondOpinion = false;
      if (raw.lessons === false) flags.lessons = false;
      if (raw.memory === false) flags.memory = false;
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
  if (process.env.PRSLOY_MEMORY === "0") flags.memory = false;
  return flags;
}
