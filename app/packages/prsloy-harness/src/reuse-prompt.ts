// Практика 18 (PLAN-alpha §3): «поиск готового» перед своим кодом, только профиль «Код»;
// плюс правило «пользователь не запускает команды» (там же, ниже).
// Источник: E3, research/REPORT-2026-10-22-part2.md §3 и experiments/wheel/run.py (вариант prior_art):
// доля проверенных библиотек 67% → 94%. Текст правила — дословно из эксперимента, плюс проверка
// существования пакета (slopsquatting, там же).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PRSLOY_CODE_PROMPT, modelDelta } from "./code-prompt.ts";
import { readFlags } from "./flags.ts";
import type { ResolvedOptions } from "./options.ts";

export const REUSE_SECTION = [
  "Before writing code, check whether a well-established library or standard module already solves the problem; prefer reusing proven, maintained solutions over writing your own, and say which one you chose and why.",
  "Before adding a dependency, confirm the package really exists in the registry (npm view <name> / pip index versions <name>); never install a package name you have not verified.",
  "Use the find_ready tool before writing a utility from scratch: it searches npm, checks the npm/PyPI names you suggest, and shows downloads, last release, license and deprecation.",
].join("\n");

// Живая приёмка №2 (дирижёр, 2026-10-25): DeepSeek и Kimi советовали владельцу «запустите python3 -m http.server».
// Пользователь — не программист (app/docs/prsloy/CONTEXT.md), команды за него запускает агент.
export const CASUAL_USER_SECTION = [
  "The user is not a programmer: never ask them to run commands, open a terminal or install anything — do it yourself.",
  "To show a page, give the file path (the app makes paths clickable), or start the preview yourself with bash_background and give the http://127.0.0.1:<port> link.",
].join("\n");

interface PromptChoice {
  custom: string | undefined;
  delta: string | undefined;
}

/**
 * Промпт «Кода». Флаг "prompt" в prsloy-harness.json: "prsloy" (по умолчанию с этапа 14, A/B на бенче) — свой
 * промпт (research/17 §9) через customPrompt, разделы уже внутри него; "pi" — база Pi плюс два раздела выше. Выбор замораживается на сессию
 * (смена флага — со следующей сессии): промпт весь сеанс байт-в-байт тот же (кэш).
 */
export function installReusePrompt(pi: ExtensionAPI, opts: ResolvedOptions): void {
  if (opts.profile !== "code") return;
  const chosen = new Map<string, PromptChoice>();
  pi.on("before_agent_start", (event, ctx) => {
    let session = "";
    try {
      session = ctx.sessionManager.getSessionId();
    } catch {
      // без сессии — общий выбор
    }
    let choice = chosen.get(session);
    if (!choice) {
      const flags = readFlags(opts.settingsPath);
      choice =
        flags.prompt === "prsloy"
          ? {
              custom: PRSLOY_CODE_PROMPT,
              delta: flags.promptDelta ? modelDelta(ctx.model?.id) : undefined,
            }
          : { custom: undefined, delta: undefined };
      chosen.set(session, choice);
    }
    const o = event.systemPromptOptions;
    if (choice.custom) {
      o.customPrompt = choice.custom;
      if (choice.delta) o.sections.prsloy_model = choice.delta;
      return;
    }
    // Один и тот же текст на каждый ход: префикс промпта не меняется, кэш не ломается (ADR-1).
    o.sections.prsloy_reuse_first = REUSE_SECTION;
    o.sections.prsloy_casual_user = CASUAL_USER_SECTION;
  });
}
