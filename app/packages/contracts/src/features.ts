/**
 * Features of the «Код» tab taken from open-source analogs (research 19 §1). Main checks
 * the sender and every argument; the renderer gets plain results, no paths it did not ask for.
 */
export type ProjectZipResult =
  | { ok: true; path: string; files: number }
  | { ok: false; reason: "canceled" | "empty" | "too_big" | "outside_workspace" };

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

export interface FeaturesApi {
  /** «Скачать архив»: the project as a zip wherever the owner saves it; shown in its folder. */
  exportProjectZip(workspacePath: string | undefined): Promise<ProjectZipResult>;
  /**
   * «Снять часть страницы»: a PNG of this rectangle of the app window (CSS pixels), saved
   * with the pasted pictures; the path goes into the composer's attachments.
   */
  /** Old chats where every word of the query occurs («ё» = «е»), newest first. */
  searchChats(query: string): Promise<ChatSearchResult[]>;
  capturePreview(rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): Promise<PreviewCaptureResult>;
}
