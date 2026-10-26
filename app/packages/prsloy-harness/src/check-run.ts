// Прогон проверки проекта с запасным вариантом (issue #37): нет pytest — `python -m unittest discover`. Общий для
// гейта, стража (копия со старыми тестами) и fail-to-pass, чтобы все трое видели одну и ту же проверку.
import type { CheckRun, CheckRunner, ProjectCheck } from "./stop-gate.ts";

/** Проверка, которая на самом деле отработала, и её прогон. Запасная — если у основной нет инструмента. */
export async function runCheck(
  runner: CheckRunner,
  check: ProjectCheck,
  cwd: string,
  timeoutMs: number,
): Promise<{ check: ProjectCheck; run: CheckRun }> {
  const run = await runner(check, cwd, timeoutMs);
  if (!run.timedOut && check.fallback && check.missingTool?.test(run.output))
    return { check: check.fallback, run: await runner(check.fallback, cwd, timeoutMs) };
  return { check, run };
}

/** Проверять было нечем: таймаут не считается, «инструмента нет» и «тестов не нашлось» — да. */
export function nothingChecked(check: ProjectCheck, run: CheckRun): boolean {
  return !run.timedOut && !!check.missingTool?.test(run.output);
}
