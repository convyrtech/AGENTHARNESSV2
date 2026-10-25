// Практика 18 (PLAN-alpha §3): «поиск готового» перед своим кодом, только профиль «Код»;
// плюс правило «пользователь не запускает команды» (там же, ниже).
// Источник: E3, research/REPORT-2026-10-22-part2.md §3 и experiments/wheel/run.py (вариант prior_art):
// доля проверенных библиотек 67% → 94%. Текст правила — дословно из эксперимента, плюс проверка
// существования пакета (slopsquatting, там же).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ResolvedOptions } from "./options.ts";

export const REUSE_SECTION = [
  "Before writing code, check whether a well-established library or standard module already solves the problem; prefer reusing proven, maintained solutions over writing your own, and say which one you chose and why.",
  "Before adding a dependency, confirm the package really exists in the registry (npm view <name> / pip index versions <name>); never install a package name you have not verified.",
].join("\n");

// Живая приёмка №2 (дирижёр, 2026-10-25): DeepSeek и Kimi советовали владельцу «запустите python3 -m http.server».
// Пользователь — не программист (app/docs/prsloy/CONTEXT.md), команды за него запускает агент.
export const CASUAL_USER_SECTION = [
  "The user is not a programmer: never ask them to run commands, open a terminal or install anything — do it yourself.",
  "To show a page, give the file path (the app makes paths clickable), or start the preview yourself with bash_background and give the http://127.0.0.1:<port> link.",
].join("\n");

export function installReusePrompt(pi: ExtensionAPI, opts: ResolvedOptions): void {
  if (opts.profile !== "code") return;
  pi.on("before_agent_start", (event) => {
    // Один и тот же текст на каждый ход: префикс промпта не меняется, кэш не ломается (ADR-1).
    event.systemPromptOptions.sections.prsloy_reuse_first = REUSE_SECTION;
    event.systemPromptOptions.sections.prsloy_casual_user = CASUAL_USER_SECTION;
  });
}
