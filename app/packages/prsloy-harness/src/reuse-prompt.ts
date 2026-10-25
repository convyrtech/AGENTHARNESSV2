// Практика 18 (PLAN-alpha §3): «поиск готового» перед своим кодом, только профиль «Код».
// Источник: E3, research/REPORT-2026-10-22-part2.md §3 и experiments/wheel/run.py (вариант prior_art):
// доля проверенных библиотек 67% → 94%. Текст правила — дословно из эксперимента, плюс проверка
// существования пакета (slopsquatting, там же).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ResolvedOptions } from "./options.ts";

export const REUSE_SECTION = [
  "Before writing code, check whether a well-established library or standard module already solves the problem; prefer reusing proven, maintained solutions over writing your own, and say which one you chose and why.",
  "Before adding a dependency, confirm the package really exists in the registry (npm view <name> / pip index versions <name>); never install a package name you have not verified.",
].join("\n");

export function installReusePrompt(pi: ExtensionAPI, opts: ResolvedOptions): void {
  if (opts.profile !== "code") return;
  pi.on("before_agent_start", (event) => {
    // Один и тот же текст на каждый ход: префикс промпта не меняется, кэш не ломается (ADR-1).
    event.systemPromptOptions.sections.prsloy_reuse_first = REUSE_SECTION;
  });
}
