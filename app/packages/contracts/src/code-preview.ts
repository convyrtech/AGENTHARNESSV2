/**
 * «Код» tab preview: a page the agent wrote, or a local server it started, shown in a
 * sandboxed side panel. Main serves only the workspace (loopback static server) and
 * http://127.0.0.1:<port>; nothing else may load in the frame.
 */
export type CodePreviewTarget = { kind: "file"; path: string } | { kind: "server"; port: number };

export type CodePreviewResult =
  | { ok: true; url: string }
  | { ok: false; reason: "outside_workspace" | "missing" | "not_html" | "bad_port" | "down" };

export interface CodePreviewApi {
  /** Resolve a target to the URL the preview frame may load. */
  open(target: CodePreviewTarget, workspacePath: string | undefined): Promise<CodePreviewResult>;
  /** «Открыть в браузере»: the file in the default app, or the server URL in the browser. */
  openExternal(target: CodePreviewTarget, workspacePath: string | undefined): Promise<boolean>;
}

/** The owner's switches for the PRSLOY harness (`prsloy-harness.json` in the agent folder). */
export type HarnessFlags = {
  /** Another model family reviews the turn's changes (default on). */
  secondOpinion: boolean;
  /** «Запоминать, когда я прошу»: the harness's `memory` tool and prompt section (default off). */
  memory: boolean;
  /**
   * «Замечать важное само» (research/24 §3, core): "off" (default), "shadow" — the extractor only writes
   * candidates, nothing reaches the prompt — or true.
   */
  autoMemory: "off" | "shadow" | true;
  /** Honest exit: `report_blocker` and the T1 text in every push-back (research/24 §4.2, default off). */
  honestExit: boolean;
  /** Guard of the old tests (research/24 §4.1 H2/H3, default off until the owner decides §4.3). */
  testGuard: boolean;
  /** The agent's words checked against its calls (research/24 §4.1 H-2, default off). */
  claimCheck: boolean;
  /** `web_search` and `web_fetch` in ordinary «Код» turns (issue #23, default off until measured). */
  webTools: boolean;
  /** Usefulness of the tests the agent adds (H-3, #8): signals to the reviewer and the turn status, default off. */
  testQuality: boolean;
  /** The reviewer looks for test-fitting (H-4, #9): kinds in its prompt, code-computed facts, tests kept whole. Default off. */
  reviewerCheats: boolean;
};

export interface HarnessFlagsApi {
  get(): Promise<HarnessFlags>;
  set(patch: Partial<HarnessFlags>): Promise<HarnessFlags>;
}
