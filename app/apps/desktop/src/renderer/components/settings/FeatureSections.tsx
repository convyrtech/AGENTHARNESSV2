/**
 * The settings pages of the «features» lane — «Память» and «Поиск в интернете» — behind one branch of
 * SettingsPage, so that file stays within its line budget.
 */
import type { Locale, MessageKey } from "../../lib/i18n.ts";
import { MemorySection } from "./MemorySection.tsx";
import { SearchSection } from "./SearchSection.tsx";

export type FeatureSectionId = "memory" | "webSearch";

export function isFeatureSection(section: string): section is FeatureSectionId {
  return section === "memory" || section === "webSearch";
}

export function FeatureSection(props: {
  section: FeatureSectionId;
  tr: (key: MessageKey, vars?: Record<string, string>) => string;
  /** SettingsPage's own props: the locale and the open project. */
  page: { locale: Locale; snapshot?: { cwd?: string } | undefined };
}) {
  const { locale } = props.page;
  return props.section === "memory" ? (
    <MemorySection tr={props.tr} locale={locale} workspace={props.page.snapshot?.cwd} />
  ) : (
    <SearchSection tr={props.tr} locale={locale} />
  );
}
