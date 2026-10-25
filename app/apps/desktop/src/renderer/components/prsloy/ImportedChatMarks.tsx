/**
 * Marks of a chat brought over from another agent (#22): a quiet badge in the sidebar row and a
 * notice at the top of the chat, saying what the model works from.
 */
import type { ImportToolId } from "@zeno/contracts";
import { t, type Locale } from "@/lib/i18n";
import { IMPORT_TOOL_NAMES } from "@/lib/session-import";

export function ImportedBadge({ tool, locale }: { tool: ImportToolId; locale: Locale }) {
  const name = IMPORT_TOOL_NAMES[tool];
  return (
    <span
      className="prsloy-imported-badge"
      data-testid="imported-badge"
      title={t(locale, "prsloy.import.badgeTitle", { tool: name })}
    >
      {name}
    </span>
  );
}

export function ImportedChatNotice({ tool, locale }: { tool: ImportToolId; locale: Locale }) {
  return (
    <p className="prsloy-imported-notice" data-testid="imported-notice" role="note">
      {t(locale, "prsloy.import.notice", { tool: IMPORT_TOOL_NAMES[tool] })}
    </p>
  );
}
