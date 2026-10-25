/** «Скачать архив»: what to tell the owner after main saved (or did not save) the zip. */
import type { ProjectZipResult } from "@zeno/contracts";
import { t, type Locale } from "./i18n.ts";

export type ProjectZipNote = { kind: "ok" | "error"; text: string } | undefined;

export function projectZipNote(
  locale: Locale,
  result: ProjectZipResult | undefined,
): ProjectZipNote {
  if (!result) return { kind: "error", text: t(locale, "features.zip.failed") };
  if (result.ok) {
    const name = result.path.split(/[\\/]/u).pop() ?? result.path;
    return { kind: "ok", text: t(locale, "features.zip.saved", { name }) };
  }
  if (result.reason === "canceled") return undefined;
  if (result.reason === "empty") return { kind: "error", text: t(locale, "features.zip.empty") };
  if (result.reason === "too_big") return { kind: "error", text: t(locale, "features.zip.tooBig") };
  return { kind: "error", text: t(locale, "features.zip.failed") };
}

/** Ask main for the zip; a failed call reads as «не получилось», never as a crash. */
export async function exportProjectZip(
  locale: Locale,
  workspacePath: string | undefined,
): Promise<ProjectZipNote> {
  const result = await window.zeno.features.exportProjectZip(workspacePath).catch(() => undefined);
  return projectZipNote(locale, result);
}
