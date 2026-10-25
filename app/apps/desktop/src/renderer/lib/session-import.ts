/**
 * Chats from other agents on the first run and in settings (#22 I1): which tools to offer, which
 * chats a ticked tool brings over, how counts read, and the imported projects the folder step
 * offers next. Pure; the screen is components/prsloy/ImportChats.tsx.
 */
import type { ImportScanResult, ImportToolId } from "@zeno/contracts";
import { localeTag, type Locale, type MessageKey } from "./i18n.ts";
import { isExpandedProject, loadExpandedProjects, toggleExpandedProject } from "./project-prefs.ts";

export const IMPORT_TOOL_NAMES: Record<ImportToolId, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "pi-cli": "Pi",
};
/** At most this many chats in one go (Codex's limit). */
export const IMPORT_MAX_CHATS = 50;
export const IMPORTED_PROJECTS_KEY = "prsloy.import.projects";
const MAX_PROJECTS = 5;

export type ImportToolRow = {
  tool: ImportToolId;
  name: string;
  chats: number;
  projects: number;
  /** Ticked by default: the tool has chats from the last 30 days. */
  recommended: boolean;
};

/** Tools with something not brought over yet, in the scan's order of counts. */
export function importToolRows(scan: ImportScanResult): ImportToolRow[] {
  const selected = new Set(scan.selected);
  const rows: ImportToolRow[] = [];
  for (const tool of Object.keys(IMPORT_TOOL_NAMES) as ImportToolId[]) {
    const fresh = scan.chats.filter((c) => c.tool === tool && !c.alreadyImported);
    if (fresh.length === 0) continue;
    rows.push({
      tool,
      name: IMPORT_TOOL_NAMES[tool],
      chats: fresh.length,
      projects: new Set(fresh.map((c) => c.project)).size,
      recommended: fresh.some((c) => selected.has(c.key)),
    });
  }
  return rows;
}

/**
 * The chats ticked tools bring over: the default selection of each tool (last 30 days), or its
 * newest chats when it has none that recent; at most 50 in all, newest first.
 */
export function importKeys(scan: ImportScanResult, tools: ReadonlySet<ImportToolId>): string[] {
  const selected = new Set(scan.selected);
  const keys: string[] = [];
  for (const tool of tools) {
    const fresh = scan.chats.filter((c) => c.tool === tool && !c.alreadyImported);
    const recent = fresh.filter((c) => selected.has(c.key));
    keys.push(...(recent.length ? recent : fresh).map((c) => c.key));
  }
  const order = new Map(scan.chats.map((c, index) => [c.key, index]));
  return keys.sort((a, b) => order.get(a)! - order.get(b)!).slice(0, IMPORT_MAX_CHATS);
}

/** «1 чат / 3 чата / 5 чатов»: the key for the plural form of a count. */
export function pluralKey<Base extends string>(
  locale: Locale,
  count: number,
  base: Base,
): `${Base}.one` | `${Base}.few` | `${Base}.many` {
  const form = new Intl.PluralRules(localeTag(locale)).select(count);
  if (form === "one") return `${base}.one`;
  if (form === "few") return `${base}.few`;
  return `${base}.many`;
}

export function countText(
  t: (key: MessageKey, vars?: Record<string, string | number>) => string,
  locale: Locale,
  count: number,
  base: "prsloy.import.chats" | "prsloy.import.projects" | "prsloy.import.imported",
): string {
  return t(pluralKey(locale, count, base) as MessageKey, { count });
}

/** Remembers the folders imported chats belong to, for the folder step. */
export function saveImportedProjects(projects: readonly string[]): void {
  try {
    localStorage.setItem(IMPORTED_PROJECTS_KEY, JSON.stringify(projects.slice(0, MAX_PROJECTS)));
  } catch {
    // storage blocked: the folder step simply does not offer them
  }
}

export function readImportedProjects(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(IMPORTED_PROJECTS_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((p): p is string => typeof p === "string").slice(0, MAX_PROJECTS)
      : [];
  } catch {
    return [];
  }
}

/** Imported projects first, then the recent folders, without repeats. */
export function mergeRecentFolders(
  imported: readonly string[],
  recent: readonly string[],
  max: number,
): string[] {
  return [...new Set([...imported, ...recent])].slice(0, max);
}

/**
 * After the first run opens a project chats were brought into, its card in the sidebar starts
 * open, so the imported chats are in sight (a fresh project would otherwise start collapsed).
 */
export function expandIfImported(folder: string): boolean {
  const imported = readImportedProjects();
  if (!isExpandedProject(folder, imported)) return false;
  const expanded = loadExpandedProjects();
  if (!isExpandedProject(folder, expanded)) toggleExpandedProject(folder, expanded);
  return true;
}
