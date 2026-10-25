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
  | {
      ev: "tool";
      name: string;
      brief: string;
      /** run.py's own words for the action («Проверяю страницу на телефоне»), when it has them. */
      doing?: string;
      t?: number;
    }
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
  /** Space the tools take once installed, MB. */
  setupDiskMb: number;
  /** Workspace folder for this project (may not exist yet). */
  workspace: string;
  /** A `say` process is running for this project. */
  running: boolean;
  /** Persisted stream for this workspace, oldest first. */
  history: DesignEvent[];
  /** Gateway key is missing: the tab cannot run models. */
  needsKey: boolean;
  /**
   * The design bundle (harness + pipeline) shipped with this build. False in builds made
   * without the private pipeline: the tab shows one calm state and nothing else.
   */
  available: boolean;
  /**
   * The harness shipped but the private pipeline did not: the calm state offers «У меня есть
   * файл инструментов» (the owner's own zip or folder of design-pipeline).
   */
  canImportTools: boolean;
};

export type DesignEventMessage = { workspace: string; event: DesignEvent };

export type DesignTokenKind = "color" | "length";
export type DesignTokenLabel = "background" | "text" | "accent" | "radius" | "size" | "spacing";
/** One handle of «Настроить»: a brand variable on the page's `:root`; `label` is translated by the renderer. */
export type DesignToken = {
  name: string;
  value: string;
  kind: DesignTokenKind;
  label: DesignTokenLabel;
};
export type DesignTokenResult = { ok: true } | { ok: false; error: string };

/**
 * «Править»: one place the owner pinned on the built page and what to change there. The place is
 * what the preview inspector reported (`PreviewPick`); `width` is the preview width it was seen at.
 */
export type DesignEditPin = {
  selector: string;
  nth: number;
  of: number;
  tag: string;
  text: string;
  outerHTMLShort: string;
  /** Served file relative to `site/` and its 1-based line, when the inspector knows them. */
  file?: string;
  line?: number;
  request: string;
  width: number;
};

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
  /**
   * Start (or reuse) the static server over `site/`; resolves to the page URL. `edit` serves it
   * with the inspector («Править»: pick places on the page), a separate server.
   */
  preview(projectPath: string | undefined, edit?: boolean): Promise<{ url: string } | null>;
  /** «Применить»: the pinned places and the owner's words → one harness edit turn (onEvent). */
  edit(projectPath: string | undefined, pins: DesignEditPin[]): Promise<void>;
  openFolder(projectPath: string | undefined): Promise<void>;
  /** The built page in the system browser (main opens only its own loopback preview address). */
  openInBrowser(projectPath: string | undefined): Promise<void>;
  /** «Настроить»: the page's brand variables (background, text, accent, radius, size, spacing) and swatches. */
  tokens(projectPath: string | undefined): Promise<{ tokens: DesignToken[]; swatches: string[] }>;
  /** Show these values in the preview without saving; null drops the preview values. */
  previewTokens(
    projectPath: string | undefined,
    changes: Record<string, string> | null,
  ): Promise<DesignTokenResult>;
  /** Write the values into the page's files (checked: brand swatches, 0.5–2×, contrast). */
  saveTokens(
    projectPath: string | undefined,
    changes: Record<string, string>,
  ): Promise<DesignTokenResult>;
  /** Pick the owner's design-pipeline zip or folder; null when cancelled, else ok or a one-line error. */
  importTools(): Promise<{ ok: true } | { ok: false; error: string } | null>;
  /** «Скачать архив»: zip of site/ through a save dialog; null when cancelled or nothing built. */
  exportZip(projectPath: string | undefined): Promise<{ path: string } | null>;
  onEvent(listener: (message: DesignEventMessage) => void): () => void;
  onSetup(listener: (progress: DesignSetupProgress) => void): () => void;
}
