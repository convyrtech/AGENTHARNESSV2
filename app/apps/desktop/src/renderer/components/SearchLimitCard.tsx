/**
 * «Лимит поиска исчерпан» (issue #23): the harness's `prsloy-harness.search-limit` card. The chosen
 * search ran out, refused the key or has none; the agent already went on with the next search in the
 * chain. Buttons: «Добавить ключ» (the settings page with that provider's form open) and «Выбрать
 * другой поиск».
 */
import { SearchX } from "lucide-react";
import { t, type Locale } from "../lib/i18n.ts";
import {
  nameKey,
  parseLimitDetails,
  requestKeyForm,
  searchErrorKey,
  searchForm,
} from "../lib/search-settings.ts";
import { useShellStore } from "../store/shell-store.ts";

export function SearchLimitCard(props: { locale: Locale; text: string; details?: unknown }) {
  const tr = (key: Parameters<typeof t>[1], vars?: Record<string, string>) =>
    t(props.locale, key, vars);
  const d = parseLimitDetails(props.details);
  const title = d
    ? tr("features.web.limit.title", {
        name: tr(nameKey(d.provider)),
        reason: tr(searchErrorKey(d.code)),
      })
    : props.text.trim();
  function open(edit: boolean) {
    requestKeyForm(edit ? d?.provider : undefined);
    const store = useShellStore.getState();
    store.setSettingsSection("webSearch");
    store.setView("settings");
  }
  return (
    <div
      className="model-failure harness-card search-limit-card"
      data-kind="system"
      data-testid="search-limit-card"
      role="group"
      aria-label={title}
    >
      <div className="model-failure-head">
        <SearchX className="size-4 shrink-0" strokeWidth={1.75} />
        <span className="model-failure-title">{title}</span>
      </div>
      <p className="model-failure-hint">{tr("features.web.limit.hint")}</p>
      <div className="blocker-actions">
        {d && searchForm(d.provider) !== "none" ? (
          <button
            type="button"
            className="model-failure-retry"
            data-testid="search-limit-key"
            onClick={() => open(true)}
          >
            {tr("features.web.addKey")}
          </button>
        ) : null}
        <button
          type="button"
          className="model-failure-retry"
          data-testid="search-limit-choose"
          onClick={() => open(false)}
        >
          {tr("features.web.limit.choose")}
        </button>
      </div>
    </div>
  );
}
