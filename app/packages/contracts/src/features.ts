/**
 * Features of the «Код» tab taken from open-source analogs (research 19 §1). Main checks
 * the sender and every argument; the renderer gets plain results, no paths it did not ask for.
 */
export type ProjectZipResult =
  | { ok: true; path: string; files: number }
  | { ok: false; reason: "canceled" | "empty" | "too_big" | "outside_workspace" };

/**
 * «Выбрать на странице»: what the preview inspector (`main/preview-bridge/inspector.js`)
 * reports about the element the owner clicked. One shape for «Код» and «Дизайн».
 */
export type PreviewPick = {
  /** CSS path that finds exactly this element (`#id > tag:nth-of-type(n)`). */
  selector: string;
  /** Readable breadcrumb, up to five steps (`main > section.hero > button.cta`). */
  path: string;
  tag: string;
  /** Visible text, up to 120 characters. */
  text: string;
  /** `<tag attrs…>text…</tag>`, ~200 characters, without our own marks. */
  outerHTMLShort: string;
  /** Same tag, classes and text on the page: this is number `nth` of `of`. */
  nth: number;
  of: number;
  /** The element's box in the page's viewport, CSS pixels. */
  rect: { x: number; y: number; width: number; height: number };
  /** Page path inside the preview, e.g. `/site/index.html`. */
  page: string;
  /** Where it is written: served file (relative to the preview root), 1-based line and column. */
  file?: string;
  line?: number;
  col?: number;
  /** False when a script made the element and the place is of its nearest written parent. */
  exact?: boolean;
};

export type PreviewCaptureResult = { ok: true; path: string } | { ok: false };

export type ChatSearchMatch = { role: "user" | "assistant"; snippet: string };

export type ChatSearchResult = {
  /** The chat's session file, as the sidebar opens it. */
  path: string;
  cwd: string;
  /** The chat's name, else its first request. */
  title: string;
  updatedAt: number;
  matchCount: number;
  matches: ChatSearchMatch[];
};

/** A background process the agent started (`bash_background`), as main sees it. */
export type BackgroundProcStatus = { pid: number; alive: boolean };

export type BackgroundProcStop =
  | { ok: true }
  | { ok: false; reason: "not_ours" | "gone" | "still_running" };

/** One field of a recipe's form (`params:` in recipe.md, by the idea of goose recipes). */
export type RecipeParam = {
  key: string;
  label: string;
  inputType: "string" | "select" | "boolean";
  required: boolean;
  default?: string | boolean;
  options?: string[];
  placeholder?: string;
};

/** «Рецепты»: an offline starter with a small form (research/19 §2.1 + §2.3). */
export type RecipeInfo = {
  id: string;
  title: string;
  description: string;
  icon: string;
  params: RecipeParam[];
};

export type RecipeCreateResult =
  | { ok: true; path: string; prompt: string }
  | { ok: false; reason: "unknown" | "missing"; missing?: string[] };

export interface FeaturesApi {
  /** «Скачать архив»: the project as a zip wherever the owner saves it; shown in its folder. */
  exportProjectZip(workspacePath: string | undefined): Promise<ProjectZipResult>;
  /**
   * «Снять часть страницы»: a PNG of this rectangle of the app window (CSS pixels), saved
   * with the pasted pictures; the path goes into the composer's attachments.
   */
  /** Which of these agent processes still run (up to 50). */
  procStatus(pids: number[]): Promise<BackgroundProcStatus[]>;
  /** The last 200 lines of a process's log, secrets scrubbed; only the harness's own logs. */
  procLog(logPath: string): Promise<string | undefined>;
  /** «Остановить»: the process tree, as the harness's `process stop`; only what our host started. */
  procStop(pid: number, logPath: string): Promise<BackgroundProcStop>;
  /** The bundled recipes, in their order. */
  recipes(): Promise<RecipeInfo[]>;
  /** A new project folder with the recipe's starter files, and the request filled from the form. */
  createRecipe(id: string, values: Record<string, string | boolean>): Promise<RecipeCreateResult>;
  /** Old chats where every word of the query occurs («ё» = «е»), newest first. */
  searchChats(query: string): Promise<ChatSearchResult[]>;
  capturePreview(rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): Promise<PreviewCaptureResult>;
}
