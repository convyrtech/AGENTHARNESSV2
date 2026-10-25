/**
 * Features of the «Код» tab taken from open-source analogs (research 19 §1). Main checks
 * the sender and every argument; the renderer gets plain results, no paths it did not ask for.
 */
export type ProjectZipResult =
  | { ok: true; path: string; files: number }
  | { ok: false; reason: "canceled" | "empty" | "too_big" | "outside_workspace" };

export interface FeaturesApi {
  /** «Скачать архив»: the project as a zip wherever the owner saves it; shown in its folder. */
  exportProjectZip(workspacePath: string | undefined): Promise<ProjectZipResult>;
}
