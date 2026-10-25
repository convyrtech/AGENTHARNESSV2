/**
 * «Дизайн» tab: the harness `run.py say` JSONL protocol plus the app's own events
 * (setup progress, process exit). See playbooks/site/harness/run.py docstring.
 */

export type DesignOption = { key: string; label: string; recommended?: boolean };

/** One question of an owner message with its answer buttons (`q` may be empty). */
export type DesignOptionGroup = { q: string; options: DesignOption[] };

/** A file the harness showed the owner, served by the design protocol. */
export type DesignFile = {
  /** Path relative to the design workspace. */
  path: string;
  /** `prsloy-design://…` URL the renderer can load. */
  url: string;
  kind: "image" | "video" | "page" | "other";
};

export type DesignHarnessEvent =
  | { ev: "stage"; gate: string; title: string; model: string; attempt: number; t?: number }
  | { ev: "tool"; name: string; brief: string; t?: number }
  | { ev: "note"; text: string; t?: number }
  | { ev: "owner"; text: string; files: DesignFile[]; options: DesignOptionGroup[]; t?: number }
  | { ev: "done"; text: string; t?: number }
  | { ev: "stuck"; text: string; t?: number };

/** What the owner said; recorded so the stream survives reopening the tab. */
export type DesignUserEvent = { ev: "user"; text: string; files: string[]; t?: number };

/** The `say` process ended. `cancelled` when the owner pressed stop. */
export type DesignExitEvent = {
  ev: "exit";
  code: number | null;
  cancelled: boolean;
  /** Last stderr lines when the process failed without a stuck event. */
  error?: string;
  t?: number;
};

export type DesignEvent = DesignHarnessEvent | DesignUserEvent | DesignExitEvent;

export type DesignSetupPhase = "venv" | "download" | "install" | "browser" | "done" | "error";

export type DesignSetupProgress = {
  phase: DesignSetupPhase;
  /** Bytes downloaded so far / expected total (download phase). */
  doneBytes?: number;
  totalBytes?: number;
  /** Human error (Russian) for the error phase. */
  error?: string;
};

export type DesignStatus = {
  /** Python tools are installed and the browser is usable. */
  toolsReady: boolean;
  /** Approximate one-time download, MB (shown before setup). */
  setupMb: number;
  /** Workspace folder for this project (may not exist yet). */
  workspace: string;
  /** A `say` process is running for this project. */
  running: boolean;
  /** Persisted stream for this workspace, oldest first. */
  history: DesignEvent[];
  /** Gateway key is missing: the tab cannot run models. */
  needsKey: boolean;
};

export type DesignEventMessage = { workspace: string; event: DesignEvent };

export interface DesignApi {
  status(projectPath: string | undefined): Promise<DesignStatus>;
  /** Install Python tools once; progress arrives through onSetup. */
  setup(): Promise<DesignSetupProgress>;
  /**
   * Owner message (text and/or picked files) → harness turn; events arrive through onEvent.
   * `retry` after a stuck event starts the model ladder over.
   */
  say(
    projectPath: string | undefined,
    text: string,
    fileTokens: string[],
    retry?: boolean,
  ): Promise<void>;
  cancel(projectPath: string | undefined): Promise<void>;
  /** Native file picker; returns opaque tokens main accepts in `say`, plus display names. */
  pickFiles(): Promise<{ token: string; name: string }[]>;
  /** Start (or reuse) the static server over `site/`; resolves to the page URL. */
  preview(projectPath: string | undefined): Promise<{ url: string } | null>;
  openFolder(projectPath: string | undefined): Promise<void>;
  onEvent(listener: (message: DesignEventMessage) => void): () => void;
  onSetup(listener: (progress: DesignSetupProgress) => void): () => void;
}
