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
