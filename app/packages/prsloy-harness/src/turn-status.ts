// Статус хода по фактам (H9; research/24 §4.4–4.5, research/22 §6.4): одна карточка в конце хода, после ответа
// модели, — `prsloy-harness.turn-status` по контракту ui (apps/desktop renderer/lib/turn-status.ts): content —
// одна строка по-русски, details — { facts, files?, page? } (page — находки проверки страницы с селекторами). Модель её не пишет и не перекрывает: при красной проверке ui
// ставит карточку над ответом. Факты — из того, что видел харнесс: последний прогон гейта, проверка страницы,
// запуск программы после последней правки, дифф хода (старые тесты, заглушки).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parsePatch, TEST_FILE } from "./gate-signals.ts";
import type { ResolvedOptions } from "./options.ts";
import { oldTestChanges, userAskedToChange } from "./test-guard.ts";
import { detectProjectCheck } from "./stop-gate.ts";
import { showCard } from "./text.ts";
import type { TurnChanges } from "./turn-changes.ts";

export const TURN_STATUS_TYPE = "prsloy-harness.turn-status";

export type TurnFact =
  | "checks-fail"
  | "page-fail"
  | "stubs-left"
  | "tests-changed"
  | "tests-weak"
  | "page-hints"
  | "checks-pass"
  | "page-ok"
  | "ran-ok"
  | "tests-updated"
  | "no-checks";

/** Порядок и слова — как в ui: сначала то, что требует внимания. */
export const TURN_FACT_TEXT: Readonly<Record<TurnFact, string>> = {
  "checks-fail": "Проверки не прошли",
  "page-fail": "На странице остались ошибки — посмотрите",
  "stubs-left": "Остались заглушки",
  "tests-changed": "Агент поменял старые проверки — посмотрите",
  "tests-weak": "Новые тесты почти ничего не проверяют — посмотрите",
  "page-hints": "Есть подсказки по удобству страницы",
  "checks-pass": "Проверки прошли",
  "page-ok": "Страница открылась без ошибок",
  "ran-ok": "Программу запускал — работает",
  "tests-updated": "Проверки обновлены по вашей просьбе",
  "no-checks": "Проверить нечем — в проекте нет проверок",
};
const ORDER = Object.keys(TURN_FACT_TEXT) as TurnFact[];

/** Что видел харнесс за сообщение пользователя. Гейт пишет сюда свои прогоны. */
export interface TurnStatusState {
  task: string;
  /** Последний прогон проверки проекта (гейт): зелёный, красный или не было. */
  gate: "green" | "red" | undefined;
  /** У проекта есть своя проверка (гейт её нашёл). */
  hasCheck: boolean;
  /** Проверка страницы в браузере: true — без ошибок, false — с ошибками. */
  page: boolean | undefined;
  /** Находки сценария на странице с селекторами (pageFindings): нажатия, ссылки, доступность, клавиатура. */
  pageIssues: string[];
  /** Правки edit/write в этом сообщении. */
  edited: boolean;
  /** Программу запускали после последней правки, и она отработала. */
  ranOk: boolean;
  /** Слабые новые тесты (H-3, флаг testQuality): файлы. */
  weakTests: string[];
}

export function createTurnStatus(): TurnStatusState {
  return {
    task: "",
    gate: undefined,
    hasCheck: false,
    page: undefined,
    pageIssues: [],
    edited: false,
    ranOk: false,
    weakTests: [],
  };
}

/** Запуск самой программы (не установка, не тест): `python app.py`, `node bot.js`, `.venv/Scripts/python x.py`. */
const RUNS_PROGRAM =
  /(?:^|&&|;|\|\|)\s*(?:\S*[\\/])?(?:python3?|py|node)(?:\.exe)?\s+(?:-[\w-]+\s+)*(?!-m\s+(?:pytest|unittest|pip))[^\s;&|]+\.(?:py|m?js|cjs)\b/;
const TEST_RUN = /\b(?:pytest|unittest|jest|vitest|mocha|npm (?:run )?test|node --test)\b/;

/** Заглушки вместо кода (H7) в добавленных строках. `@abstractmethod` в двух строках выше — не заглушка. */
const STUB =
  /\b(?:TODO|FIXME)\b.*\b(?:implement|реализ)|rest of (?:the )?code|existing code here|your code here|остальн\p{L}* (?:код|отч\p{L}*|функци\p{L}*)|здесь будет|(?:#|\/\/)\s*(?:\.\.\.|…)|\braise NotImplementedError\b|throw new Error\(\s*["'`](?:not implemented|todo)/iu;

export function stubFiles(patch: string): string[] {
  const out: string[] = [];
  for (const f of parsePatch(patch)) {
    if (f.isDeleted || TEST_FILE.test(f.file)) continue;
    const hit = f.added.some(
      (line, i) =>
        STUB.test(line) &&
        !f.added.slice(Math.max(0, i - 2), i).some((l) => /@abstractmethod/.test(l)),
    );
    if (hit) out.push(f.file);
  }
  return out;
}

/** Факты хода и файлы (заглушки, тронутые старые тесты); undefined — ход ничего не делал, карточки нет. */
export function turnFacts(
  state: TurnStatusState,
  patch: string | undefined,
  filesChanged: number,
): { facts: TurnFact[]; files: string[]; page?: string[] } | undefined {
  const edited = state.edited || filesChanged > 0;
  if (!edited && state.gate === undefined) return undefined;
  const facts = new Set<TurnFact>();
  const files: string[] = [];
  if (state.gate === "red") facts.add("checks-fail");
  else if (state.gate === "green") facts.add("checks-pass");
  if (state.page === true) facts.add("page-ok");
  else if (state.page === false) facts.add("page-fail");
  if (state.page === true && state.pageIssues.length) facts.add("page-hints");
  if (state.ranOk) facts.add("ran-ok");
  // Страница открылась или программа отработала — это и есть проверка для новичка: «нечем» только если не было ничего.
  if (edited && !state.hasCheck && state.page !== true && !state.ranOk) facts.add("no-checks");
  if (patch) {
    const tests = oldTestChanges(patch);
    if (tests.length) {
      facts.add(userAskedToChange(state.task) ? "tests-updated" : "tests-changed");
      files.push(...tests.map((t) => t.file));
    }
    if (state.weakTests.length) {
      facts.add("tests-weak");
      files.push(...state.weakTests);
    }
    const stubs = stubFiles(patch);
    if (stubs.length) {
      facts.add("stubs-left");
      files.push(...stubs);
    }
  }
  const ordered = ORDER.filter((f) => facts.has(f));
  if (!ordered.length) return undefined;
  const page = state.page === undefined ? [] : state.pageIssues;
  return { facts: ordered, files: [...new Set(files)], ...(page.length ? { page } : {}) };
}

export function turnStatusLine(facts: TurnFact[]): string {
  return facts.map((f) => TURN_FACT_TEXT[f]).join(" · ");
}

export function installTurnStatus(
  pi: ExtensionAPI,
  opts: ResolvedOptions,
  deps: { state: TurnStatusState; changes?: TurnChanges | undefined },
): void {
  if (opts.profile !== "code") return;
  const { state, changes } = deps;

  pi.on("before_agent_start", (event) => {
    if (event.messageType !== "user") return;
    Object.assign(state, createTurnStatus(), { task: event.prompt });
  });

  pi.on("tool_result", (event) => {
    if ((event.toolName === "edit" || event.toolName === "write") && !event.isError) {
      state.edited = true;
      state.ranOk = false;
    } else if (event.toolName === "bash" && !event.isError) {
      const command = (event.input as { command?: unknown }).command;
      if (typeof command === "string" && RUNS_PROGRAM.test(command) && !TEST_RUN.test(command))
        state.ranOk = true;
    } else if (event.toolName === "bash_background" && !event.isError) state.ranOk = true;
    return undefined;
  });

  // Конец хода — после ответа модели и последнего решения гейта: agent_settled (agent_end Pi шлёт до гейта и на
  // каждый продолжённый кусок хода). Карточка встаёт под ответом; красную ui поднимает над ним. «Стоп» — без
  // карточки: гейт не успел, факты неполные.
  pi.on("agent_settled", async (event, ctx) => {
    if (event.aborted) return;
    // Гейт не успел прогнать проверку (стоп, бюджет) — «нечем проверить» говорим, только если её правда нет.
    if (state.gate === undefined && !state.hasCheck) state.hasCheck = !!detectProjectCheck(ctx.cwd);
    const diff = changes?.peekLastDiff();
    const result = turnFacts(state, diff?.patch, diff?.files.length ?? 0);
    if (!result) return;
    await showCard(pi, TURN_STATUS_TYPE, turnStatusLine(result.facts), {
      facts: result.facts,
      ...(result.files.length ? { files: result.files } : {}),
      ...(result.page ? { page: result.page } : {}),
    });
  });
}
