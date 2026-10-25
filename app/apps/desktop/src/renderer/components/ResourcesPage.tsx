/** Resources view (moved out of main.tsx, which is at its line budget). */
import type { ResourceSummary } from "@zeno/contracts";
import { t, type Locale } from "../lib/i18n.ts";

export function ResourcesPage(props: {
  locale: Locale;
  resources: ResourceSummary[];
  loading: boolean;
  onRefresh: () => void;
}) {
  const tr = (key: Parameters<typeof t>[1], vars?: Record<string, string>) =>
    t(props.locale, key, vars);
  return (
    <section className="page" data-testid="resources-page">
      <header className="page-header">
        <h1>{tr("resources.title")}</h1>
        <div className="page-header-actions">
          <button
            type="button"
            className="btn-secondary"
            data-testid="resources-refresh"
            onClick={props.onRefresh}
            disabled={props.loading}
          >
            {props.loading ? tr("resources.loading") : tr("resources.refresh")}
          </button>
        </div>
      </header>
      <div className="page-body">
        <div className="page-body-inner">
          {props.resources.length === 0 ? (
            <div className="empty-panel" data-testid="resources-empty">
              <h2>{tr("resources.emptyTitle")}</h2>
              <p>{tr("resources.emptyBody")}</p>
            </div>
          ) : (
            <div className="item-list" data-testid="resources-list">
              {props.resources.map((item) => (
                <article key={`${item.kind}:${item.path}:${item.name}`} className="item-card">
                  <div className="min-w-0">
                    <div className="title">{item.name}</div>
                    <div className="meta">
                      {item.path || "—"}
                      {item.source ? ` · ${item.source}` : ""}
                      {item.kind === "context" || item.kind === "system"
                        ? tr("resources.contextHint")
                        : ""}
                    </div>
                  </div>
                  <div className="badges flex items-center gap-2">
                    <span className="chip">{item.kind}</span>
                    {item.path ? (
                      <button
                        type="button"
                        className="btn-ghost text-xs"
                        data-testid={`resource-open-${item.kind}-${item.name}`}
                        onClick={() => void window.zeno.workspace.openFile(item.path)}
                      >
                        {tr("resources.open")}
                      </button>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
