// Практика 7 (PLAN-alpha §3): проверка после правки дописывается в результат тула.
// Источник: ADR-6, research/06-harness2.md — «инструкцию модель может пропустить, строку в результате тула — нет»
// (verify-скрипт 43 → 78).
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { checkFile, type CheckerEnv } from "./checkers.ts";
import type { ResolvedOptions } from "./options.ts";
import { appendText, keepStructured } from "./text.ts";

export function resolvePath(cwd: string, path: string): string {
  const clean = path.startsWith("@") ? path.slice(1) : path;
  return isAbsolute(clean) ? clean : resolve(cwd, clean);
}

export function installPostEditVerify(
  pi: ExtensionAPI,
  opts: ResolvedOptions,
  env: CheckerEnv = {},
): void {
  const checkerEnv: CheckerEnv = { nodePath: opts.nodePath, pythonPath: opts.pythonPath, ...env };

  pi.on("tool_result", async (event, ctx) => {
    if ((event.toolName !== "edit" && event.toolName !== "write") || event.isError)
      return undefined;
    const path = event.input.path;
    if (typeof path !== "string") return undefined;
    const absolute = resolvePath(ctx.cwd, path);
    let source: string;
    try {
      source = await readFile(absolute, "utf8");
    } catch {
      return undefined;
    }
    const result = await checkFile(absolute, source, checkerEnv);
    if (!result) return undefined;
    const note = result.ok
      ? `[Проверка синтаксиса (${result.tool}): ок]`
      : `[Проверка синтаксиса (${result.tool}): ОШИБКА в ${path}\n${result.message ?? ""}\nИсправь это до следующего шага.]`;
    return { content: appendText(event.content, note), ...keepStructured(event) };
  });
}
