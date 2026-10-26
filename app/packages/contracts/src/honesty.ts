/**
 * The honest exit (research/24 §4.2, §4.5): the harness's `report_blocker` card in the chat,
 * `details` of the custom message `prsloy-harness.blocker`. «Не получилось: …», «Почему: …»,
 * «Что нужно от вас: …», and buttons with ready answers.
 */
export type BlockerCardDetails = {
  /** What could not be done, in the owner's words. */
  what: string;
  /** Why: the conflict the code confirmed (a test against the request, a missing file…). */
  why: string;
  /** What the owner can do or answer. */
  need: string;
  /** The reason class the code checked (`test_conflicts_request`, `missing_file`, …). */
  reason?: string;
  /** Ready answers, each a button that sends it (at most 3). */
  options?: string[];
};

/**
 * Old tests that contradict the owner's new request (owner's decision on #25: the agent does not change existing
 * tests unasked; it tells and offers). `details` of the custom message `prsloy-harness.tests-outdated`; the content
 * is «Старые тесты расходятся с вашей просьбой — похоже, они устарели. Обновить их под новое правило?».
 */
export type TestsOutdatedCardDetails = {
  /** Old test files that disagree with the request. */
  files: string[];
  /** The conflicting assertion, quoted from an old test (may be empty when the code could not find one). */
  quote: string;
  /** The owner's request, as typed. */
  request: string;
  /**
   * Buttons in order. One with `prompt` sends it as the owner's next message («Обновить тесты» → «Обнови тесты под
   * новое правило: …», which the guard counts as an explicit request); one without `prompt` only closes the card.
   */
  actions: { label: string; prompt?: string }[];
};
