/**
 * PRSLOY desktop IPC surface (renderer ↔ main). Error codes are stable; the renderer
 * maps them to i18n keys (`prsloy.error.<code>`).
 */

export type PrsloyGatewayErrorCode =
  | "invalid_key"
  | "no_balance"
  | "network"
  | "timeout"
  | "server"
  | "bad_url";

export interface PrsloyState {
  /** A key is stored (encrypted) or held for this session. */
  hasKey: boolean;
  /** Key is held in memory only (OS offers no encryption): asked again next launch. */
  keyMemoryOnly: boolean;
  /** Masked key for display, e.g. `sk-…abcd`. */
  maskedKey: string;
  baseUrl: string;
  defaultBaseUrl: string;
  /** First run: no durable project folder chosen yet. */
  needsWorkspace: boolean;
  /** Windows: where the agent's bash comes from ("missing" = bash tool will fail). */
  shellSource?: "bundled" | "system" | "missing";
  /** prsloy-harness extensions loaded for every session. */
  harnessLoaded: boolean;
  /**
   * Skip the first-run screens (test harness with its own fake model). Main sets it for
   * `ZENO_ENABLE_TEST_COMMANDS=1` unless `PRSLOY_FORCE_FIRST_RUN=1`.
   */
  firstRunBypass: boolean;
  /**
   * Windows first launch: bundled Git (the agent's bash) is being unpacked in the
   * background. "absent" elsewhere.
   */
  gitSetup: { status: "absent" | "installing" | "ready" | "failed"; percent?: number };
  /** First launch: Node/Python + Git unpack combined into one percentage. */
  appSetup?: { status: "absent" | "installing" | "ready" | "failed"; percent?: number };
}

export type PrsloyKeyResult =
  | { ok: true; state: PrsloyState; modelIds: string[] }
  | { ok: false; code: PrsloyGatewayErrorCode; status?: number };

export interface PrsloyTurnSnapshot {
  id: string;
  turn: number;
  createdAt: string;
  sessionId?: string;
  prompt?: string;
  kind: "turn" | "undo-backup";
}

export interface PrsloyUndoResult {
  restoredTo: PrsloyTurnSnapshot;
  /** Snapshot of the state right before the undo («вернуть как было»). */
  backup?: PrsloyTurnSnapshot;
  rewritten: string[];
  removed: string[];
}

/** One remembered fact (the harness's memory, research/18 §6). */
export interface PrsloyMemoryEntry {
  id: string;
  text: string;
  scope: "user" | "project";
  created: string;
}

/** «Память»: about the user, about this project, and the code-written «last time» digest. */
export interface PrsloyMemoryList {
  user: PrsloyMemoryEntry[];
  project: PrsloyMemoryEntry[];
  digest?: { text: string; updated: string };
}

export type PrsloyMemoryChange = { ok: boolean; list: PrsloyMemoryList };

export interface PrsloyDesktopApi {
  getState(): Promise<PrsloyState>;
  /** Validate against the gateway, then store encrypted and restart the Agent Host. */
  setKey(key: string, baseUrl?: string): Promise<PrsloyKeyResult>;
  clearKey(): Promise<PrsloyState>;
  /** Change the gateway URL (Settings). Revalidates the stored key against it. */
  setBaseUrl(baseUrl: string): Promise<PrsloyKeyResult>;
  /** Snapshots taken before each agent turn in the current workspace, newest first. */
  listTurns(options?: { sessionId?: string }): Promise<PrsloyTurnSnapshot[]>;
  /** «Откатить ход»: restore the workspace to the snapshot taken before that turn. */
  undoTurn(snapshotId: string): Promise<PrsloyUndoResult>;
  /**
   * Write a support zip (versions, scrubbed logs and settings, last turns as metadata) to
   * the desktop and show it in its folder. Nothing is sent anywhere.
   */
  saveSupportReport(): Promise<PrsloySupportReportResult>;
  /** Memory for the panel; `workspace` defaults to the open project. */
  memoryList(workspace?: string): Promise<PrsloyMemoryList>;
  /** «Забыть»: the entry goes to tombstones; an open session is told with a hidden note. */
  memoryForget(id: string, workspace?: string): Promise<PrsloyMemoryChange>;
  /** «Вернуть» right after «Забыть». */
  memoryRestore(id: string, workspace?: string): Promise<PrsloyMemoryChange>;
  /** «Забыть всё»: about the user and every project. */
  memoryForgetAll(): Promise<PrsloyMemoryChange>;
}

export type PrsloySupportReportResult =
  | { ok: true; path: string; name: string }
  | { ok: false; error: string };
