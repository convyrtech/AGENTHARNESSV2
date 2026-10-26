// Старые тесты расходятся с новой просьбой (решение владельца по #25): агент не меняет существующие тесты без
// просьбы, а говорит об этом и предлагает обновить. Карточка `prsloy-harness.tests-outdated` с кнопками
// [Обновить тесты] / [Оставить как есть]; первая шлёт фразу, которую страж считает явной просьбой (§4.3).
// Карточку показывают страж (старые тесты на новом коде красные, ход кончился красным) и report_blocker с причиной
// test_conflicts_request — раз за сообщение пользователя, кто первый.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ASSERT, parsePatch, TEST_FILE } from "./gate-signals.ts";
import { showCard } from "./text.ts";

/** Как `TestsOutdatedCardDetails` в packages/contracts/src/honesty.ts (карточка ui): details сообщения. */
export interface TestsOutdatedCardDetails {
  files: string[];
  quote: string;
  request: string;
  actions: { label: string; prompt?: string }[];
}

export const TESTS_OUTDATED_TYPE = "prsloy-harness.tests-outdated";
export const TESTS_OUTDATED_CARD =
  "Старые тесты расходятся с вашей просьбой — похоже, они устарели. Обновить их под новое правило?";

/** Сообщение кнопки «Обновить тесты»: страж считает его явной просьбой поменять тесты (test-guard.ts, §4.3). */
export function updateTestsPrompt(request: string): string {
  return `Обнови тесты под новое правило: ${request.trim().replace(/\s+/g, " ").slice(0, 300)}`;
}

/** Показана ли карточка в этом сообщении (общее у стража и report_blocker). */
export interface TestsOutdatedState {
  shown: boolean;
}

export function testsOutdatedDetails(
  files: string[],
  quote: string,
  request: string,
): TestsOutdatedCardDetails {
  return {
    files,
    quote: quote.trim().slice(0, 200),
    request: request.trim().slice(0, 500),
    actions: [
      { label: "Обновить тесты", prompt: updateTestsPrompt(request) },
      { label: "Оставить как есть" },
    ],
  };
}

/** Проверка, которую агент пытался убрать или поменять в старых тестах (строка «−»). */
export function conflictingAssertion(patch: string): { files: string[]; quote: string } {
  const old = parsePatch(patch).filter((f) => !f.isNew && TEST_FILE.test(f.file));
  const removed = old.flatMap((f) => f.removed).filter((l) => l.trim());
  // Явная проверка (assert/expect), иначе первая убранная строка: `if (got !== 170) { … exit(1) }` — тоже проверка.
  const quote = removed.find((l) => ASSERT.test(l)) ?? removed[0] ?? "";
  return { files: old.map((f) => f.file), quote: quote.trim() };
}

export async function showTestsOutdated(
  pi: Pick<ExtensionAPI, "sendMessage">,
  state: TestsOutdatedState,
  details: TestsOutdatedCardDetails,
): Promise<void> {
  if (state.shown) return;
  state.shown = true;
  await showCard(pi, TESTS_OUTDATED_TYPE, TESTS_OUTDATED_CARD, details);
}
