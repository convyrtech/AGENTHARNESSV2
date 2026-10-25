/** Packages view (moved out of main.tsx, which is at its line budget). */
import type { CatalogPackage, McpConfig, PackageSummary } from "@zeno/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { McpServersSection } from "./McpServersSection.tsx";
import {
  SettingsSearchField,
  SettingsSelect,
  SettingsToggle,
} from "./settings/SettingsPrimitives.tsx";
import { t, type Locale } from "../lib/i18n.ts";

export function PackagesPage(props: {
  locale: Locale;
  packages: PackageSummary[];
  loading: boolean;
  onRefresh: () => void;
  onInstall: (
    source: string,
    scope: "global" | "project",
    options?: { temporary?: boolean },
  ) => Promise<void>;
  onRemove: (source: string, scope: "global" | "project") => Promise<void>;
  onUpdate: (source?: string) => Promise<void>;
  onCheckUpdates: () => Promise<
    Array<{ source: string; displayName: string; type: "npm" | "git"; scope: "global" | "project" }>
  >;
  onSetEnabled: (source: string, scope: "global" | "project", enabled: boolean) => Promise<void>;
}) {
  const tr = (key: Parameters<typeof t>[1], vars?: Record<string, string>) =>
    t(props.locale, key, vars);
  /** Trial install: like CLI `-e` — not written to settings. */
  const [temporary, setTemporary] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Sources known to have an available update after the last check. */
  const [updateSources, setUpdateSources] = useState<Set<string>>(() => new Set());
  const [updatesChecked, setUpdatesChecked] = useState(false);
  const CATALOG_PAGE = 20;
  const [tab, setTab] = useState<"installed" | "discover">("installed");
  const [catalogQuery, setCatalogQuery] = useState("");
  const [catalog, setCatalog] = useState<CatalogPackage[]>([]);
  const [catalogTotal, setCatalogTotal] = useState(0);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogLoadingMore, setCatalogLoadingMore] = useState(false);
  const [catalogError, setCatalogError] = useState<string>();
  const [installingSource, setInstallingSource] = useState<string>();
  const [discoverScope, setDiscoverScope] = useState<"global" | "project">("global");
  /** Discover tab: plugin packages vs MCP servers. */
  const [discoverType, setDiscoverType] = useState<"plugin" | "mcp">("plugin");
  /** Installed MCP servers from mcp.json. */
  const [mcpServers, setMcpServers] = useState<McpConfig>({ mcpServers: {} });
  /** True when MCP config was modified and needs a host restart to take effect. */
  const [mcpDirty, setMcpDirty] = useState(false);
  const catalogLoadGen = useRef(0);
  const catalogLoadingMoreRef = useRef(false);
  const catalogEndRef = useRef<HTMLDivElement | null>(null);

  const installedSources = useMemo(() => {
    const set = new Set<string>();
    for (const p of props.packages) {
      set.add(p.source);
      // also match bare name without npm: prefix
      if (p.source.startsWith("npm:")) set.add(p.source.slice(4));
    }
    return set;
  }, [props.packages]);

  const catalogHasMore = catalog.length < catalogTotal;

  async function loadCatalog(query = catalogQuery) {
    const gen = ++catalogLoadGen.current;
    setCatalogLoading(true);
    setCatalogError(undefined);
    setCatalogLoadingMore(false);
    catalogLoadingMoreRef.current = false;
    try {
      const result =
        discoverType === "mcp"
          ? await window.zeno.mcp.searchCatalog(query.trim() || undefined, CATALOG_PAGE, 0)
          : await window.zeno.packages.searchCatalog(query.trim() || undefined, CATALOG_PAGE, 0);
      if (gen !== catalogLoadGen.current) return;
      setCatalog(result.packages);
      setCatalogTotal(result.total);
    } catch (error) {
      if (gen !== catalogLoadGen.current) return;
      setCatalog([]);
      setCatalogTotal(0);
      setCatalogError(error instanceof Error ? error.message : tr("packages.discoverFailed"));
    } finally {
      if (gen === catalogLoadGen.current) setCatalogLoading(false);
    }
  }

  async function loadMoreCatalog() {
    if (!catalogHasMore || catalogLoading || catalogLoadingMoreRef.current) return;
    catalogLoadingMoreRef.current = true;
    setCatalogLoadingMore(true);
    const gen = catalogLoadGen.current;
    const from = catalog.length;
    try {
      const result =
        discoverType === "mcp"
          ? await window.zeno.mcp.searchCatalog(
              catalogQuery.trim() || undefined,
              CATALOG_PAGE,
              from,
            )
          : await window.zeno.packages.searchCatalog(
              catalogQuery.trim() || undefined,
              CATALOG_PAGE,
              from,
            );
      if (gen !== catalogLoadGen.current) return;
      if (result.packages.length === 0) {
        // Registry has no more pages — clamp total so we stop requesting.
        setCatalogTotal(from);
        return;
      }
      setCatalog((prev) => {
        const seen = new Set(prev.map((p) => p.name));
        const next = [...prev];
        for (const item of result.packages) {
          if (seen.has(item.name)) continue;
          seen.add(item.name);
          next.push(item);
        }
        return next;
      });
      setCatalogTotal(result.total);
    } catch (error) {
      if (gen !== catalogLoadGen.current) return;
      setCatalogError(error instanceof Error ? error.message : tr("packages.discoverFailed"));
    } finally {
      if (gen === catalogLoadGen.current) {
        catalogLoadingMoreRef.current = false;
        setCatalogLoadingMore(false);
      }
    }
  }

  useEffect(() => {
    if (tab !== "discover") return;
    void loadCatalog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, discoverType]);

  // Load MCP config when viewing installed tab
  useEffect(() => {
    if (tab === "installed") void loadMcpConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  useEffect(() => {
    if (tab !== "discover") return;
    const handle = window.setTimeout(() => void loadCatalog(catalogQuery), 320);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogQuery]);

  // Infinite scroll: load next page when the list end enters the page-body viewport.
  useEffect(() => {
    if (tab !== "discover" || !catalogHasMore || catalogLoading) return;
    const sentinel = catalogEndRef.current;
    if (!sentinel) return;
    const root = sentinel.closest(".page-body");
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMoreCatalog();
      },
      { root: root instanceof Element ? root : null, rootMargin: "160px", threshold: 0 },
    );
    io.observe(sentinel);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, catalogHasMore, catalogLoading, catalogLoadingMore, catalog.length, catalogQuery]);

  async function installFromCatalog(item: CatalogPackage) {
    setInstallingSource(item.source);
    setBusy(true);
    try {
      await props.onInstall(
        item.source,
        discoverScope,
        temporary ? { temporary: true } : undefined,
      );
      props.onRefresh();
    } catch {
      // modal via parent
    } finally {
      setInstallingSource(undefined);
      setBusy(false);
    }
  }

  async function installMcpFromCatalog(item: CatalogPackage) {
    setInstallingSource(item.source);
    setBusy(true);
    try {
      // Derive a short server name from the package name
      const name = item.name.startsWith("@") ? item.name.split("/").pop()! : item.name;
      await window.zeno.mcp.installServer(name, item.name);
      await loadMcpConfig();
      setMcpDirty(true);
    } catch {
      // parent reports error
    } finally {
      setInstallingSource(undefined);
      setBusy(false);
    }
  }

  async function removeMcp(name: string) {
    setBusy(true);
    try {
      await window.zeno.mcp.removeServer(name);
      await loadMcpConfig();
      // Reload the agent host so pi-mcp-adapter re-reads mcp.json and
      // disconnects from the removed server immediately.  Removal is safe
      // to reload — we are removing a server, not adding one, so a crash
      // loop from a broken server is impossible.
      try {
        await window.zeno.runtime.reload();
        setMcpDirty(false);
      } catch {
        // Host may not be running yet; config is already saved.  Show the
        // pending hint so the user knows to restart manually.
        setMcpDirty(true);
      }
    } catch {
      // parent reports error
    } finally {
      setBusy(false);
    }
  }

  async function setMcpEnabled(name: string, enabled: boolean) {
    setBusy(true);
    try {
      await window.zeno.mcp.setEnabled(name, enabled);
      await loadMcpConfig();
      setMcpDirty(true);
    } catch {
      // parent reports error
    } finally {
      setBusy(false);
    }
  }

  async function updateMcp(name: string) {
    setBusy(true);
    try {
      await window.zeno.mcp.updateServer(name);
      setMcpDirty(true);
    } catch {
      // parent reports error
    } finally {
      setBusy(false);
    }
  }

  async function loadMcpConfig() {
    try {
      const cfg = await window.zeno.mcp.getConfig();
      setMcpServers(cfg);
    } catch {
      // keep previous state
    }
  }

  function formatWeekly(n: number | undefined): string | undefined {
    if (n == null || !Number.isFinite(n)) return undefined;
    if (n >= 1000)
      return tr("packages.discoverWeekly", { n: `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K` });
    return tr("packages.discoverWeekly", { n: String(Math.round(n)) });
  }

  async function runCheckUpdates() {
    setBusy(true);
    try {
      const updates = await props.onCheckUpdates();
      setUpdateSources(new Set(updates.map((u) => u.source)));
      setUpdatesChecked(true);
    } catch {
      // parent reports error
    } finally {
      setBusy(false);
    }
  }

  async function runUpdate(source?: string) {
    setBusy(true);
    try {
      await props.onUpdate(source);
      if (source) {
        setUpdateSources((prev) => {
          const next = new Set(prev);
          next.delete(source);
          return next;
        });
      } else {
        setUpdateSources(new Set());
      }
      setUpdatesChecked(true);
    } catch {
      // parent reports error
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="page" data-testid="packages-page">
      <header className="page-header">
        <h1>{tr("packages.title")}</h1>
        <div className="page-header-actions">
          <button
            type="button"
            className="btn-secondary"
            data-testid="packages-refresh"
            onClick={() => {
              if (tab === "discover") void loadCatalog();
              else props.onRefresh();
            }}
            disabled={props.loading || busy || catalogLoading}
          >
            {props.loading || catalogLoading ? tr("packages.loading") : tr("packages.refresh")}
          </button>
          {tab === "installed" ? (
            <>
              <button
                type="button"
                className="btn-secondary"
                data-testid="packages-check-updates"
                onClick={() => void runCheckUpdates()}
                disabled={props.loading || busy || props.packages.length === 0}
                title={tr("packages.checkUpdatesHint")}
              >
                {tr("packages.checkUpdates")}
              </button>
              {updatesChecked && updateSources.size > 0 ? (
                <button
                  type="button"
                  className="btn-secondary"
                  data-testid="packages-update-all"
                  onClick={() => void runUpdate()}
                  disabled={props.loading || busy}
                >
                  {tr("packages.updateAllAvailable")}
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      </header>
      <div className="page-tabs" data-testid="packages-tabs">
        <button
          type="button"
          className="page-tab"
          data-active={tab === "installed" ? "true" : "false"}
          data-testid="packages-tab-installed"
          onClick={() => setTab("installed")}
        >
          {tr("packages.tab.installed")}
        </button>
        <button
          type="button"
          className="page-tab"
          data-active={tab === "discover" ? "true" : "false"}
          data-testid="packages-tab-discover"
          onClick={() => setTab("discover")}
        >
          {tr("packages.tab.discover")}
        </button>
      </div>
      <div className="page-body">
        <div className="page-body-inner">
          {tab === "discover" ? (
            <div data-testid="packages-discover">
              {/* One toolbar: search · scope · open web · trial toggle. Install only via list. */}
              <div
                className="mb-3 flex min-w-0 flex-nowrap items-center gap-2"
                data-testid="packages-discover-toolbar"
              >
                <SettingsSearchField
                  testId="packages-discover-search"
                  value={catalogQuery}
                  onChange={setCatalogQuery}
                  placeholder={tr("packages.discoverSearch")}
                  className="min-w-0 flex-1"
                />
                <SettingsSelect
                  testId="packages-discover-type"
                  size="md"
                  className="h-9 shrink-0"
                  value={discoverType}
                  onChange={(v) => setDiscoverType(v as "plugin" | "mcp")}
                  disabled={busy || Boolean(installingSource)}
                  options={[
                    { value: "plugin", label: tr("packages.installedSection") },
                    { value: "mcp", label: tr("mcp.scopeLabel") },
                  ]}
                />
                {discoverType === "plugin" ? (
                  <SettingsSelect
                    testId="packages-discover-scope"
                    size="md"
                    className="h-9 shrink-0"
                    value={discoverScope}
                    onChange={(v) => setDiscoverScope(v as "global" | "project")}
                    disabled={busy || Boolean(installingSource)}
                    options={[
                      { value: "global", label: tr("packages.scopeGlobal") },
                      { value: "project", label: tr("packages.scopeProject") },
                    ]}
                  />
                ) : null}
                {discoverType === "plugin" ? (
                  <a
                    className="btn-secondary inline-flex h-9 shrink-0 items-center whitespace-nowrap no-underline"
                    href="https://pi.dev/packages"
                    target="_blank"
                    rel="noreferrer"
                    data-testid="packages-catalog-link"
                  >
                    {tr("packages.discoverOpenWeb")}
                  </a>
                ) : null}
                {discoverType === "plugin" ? (
                  <div
                    className="flex h-9 shrink-0 items-center gap-2 rounded-full border border-[var(--border)] px-2.5"
                    data-testid="package-temporary-label"
                    title={tr("packages.temporary")}
                  >
                    <span className="whitespace-nowrap text-[12px] text-[var(--muted-foreground)]">
                      {tr("packages.installTemp")}
                    </span>
                    <SettingsToggle
                      checked={temporary}
                      onChange={setTemporary}
                      disabled={props.loading || busy}
                      testId="package-temporary"
                      aria-label={tr("packages.temporary")}
                    />
                  </div>
                ) : null}
              </div>
              {catalogError ? (
                <p className="form-error" data-testid="packages-discover-error">
                  {catalogError}
                </p>
              ) : null}
              {catalogLoading && catalog.length === 0 ? (
                <p className="m-0 text-[13px] text-[var(--muted-foreground)]">
                  {tr("packages.discoverLoading")}
                </p>
              ) : catalog.length === 0 ? (
                <div className="empty-panel" data-testid="packages-discover-empty">
                  <p>{tr("packages.discoverEmpty")}</p>
                </div>
              ) : (
                <div className="item-list" data-testid="packages-discover-list">
                  {catalog.map((item) => {
                    const mcpName = item.name.startsWith("@")
                      ? item.name.split("/").pop()!
                      : item.name;
                    const installed =
                      discoverType === "mcp"
                        ? mcpName in (mcpServers.mcpServers ?? {})
                        : installedSources.has(item.source) || installedSources.has(item.name);
                    const installing = installingSource === item.source;
                    return (
                      <article
                        key={item.name}
                        className="item-card"
                        data-testid={`catalog-package-${item.name}`}
                      >
                        <div className="min-w-0 flex-1">
                          <a
                            className="title cursor-pointer no-underline hover:underline"
                            href={`https://www.npmjs.com/package/${item.name}`}
                            target="_blank"
                            rel="noreferrer"
                            title={`${tr("packages.discoverOpenWeb")} → ${item.name}`}
                          >
                            {item.name}
                          </a>
                          <div className="meta">
                            v{item.version}
                            {item.publisher ? ` · ${item.publisher}` : ""}
                            {formatWeekly(item.weeklyDownloads)
                              ? ` · ${formatWeekly(item.weeklyDownloads)}`
                              : ""}
                          </div>
                          {item.description ? (
                            <p className="m-0 mt-1.5 text-[12.5px] leading-snug text-[var(--muted-foreground)]">
                              {item.description}
                            </p>
                          ) : null}
                          <div className="mt-1 font-mono text-[11px] text-[var(--text-subtle)]">
                            {item.source}
                          </div>
                        </div>
                        <div className="badges">
                          {item.keywords
                            ?.filter((k) => k !== "pi-package" && k !== "mcp-server")
                            .slice(0, 3)
                            .map((k) => (
                              <span key={k} className="chip">
                                {k}
                              </span>
                            ))}
                          <button
                            type="button"
                            className="btn-primary btn-sm"
                            data-testid={`catalog-install-${item.name}`}
                            disabled={installed || installing || busy || props.loading}
                            onClick={() =>
                              discoverType === "mcp"
                                ? void installMcpFromCatalog(item)
                                : void installFromCatalog(item)
                            }
                            title={
                              discoverType === "mcp"
                                ? tr("mcp.install")
                                : temporary
                                  ? tr("packages.temporary")
                                  : tr("packages.discoverInstall")
                            }
                          >
                            {installed
                              ? tr(
                                  discoverType === "mcp"
                                    ? "mcp.installed"
                                    : "packages.discoverInstalled",
                                )
                              : installing
                                ? tr("mcp.installing")
                                : discoverType === "mcp"
                                  ? tr("mcp.install")
                                  : temporary
                                    ? tr("packages.installTemp")
                                    : tr("packages.discoverInstall")}
                          </button>
                        </div>
                      </article>
                    );
                  })}
                  <div
                    ref={catalogEndRef}
                    className="py-2 text-center text-[12px] text-[var(--text-subtle)]"
                    data-testid="packages-discover-scroll-end"
                  >
                    {catalogLoadingMore
                      ? tr("packages.discoverLoadingMore")
                      : catalogHasMore
                        ? null
                        : catalog.length > 0
                          ? tr("packages.discoverEnd")
                          : null}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <>
              {props.packages.length === 0 ? (
                <div className="empty-panel" data-testid="packages-empty">
                  <h2>{tr("packages.emptyTitle")}</h2>
                  <p>{tr("packages.emptyBody")}</p>
                </div>
              ) : (
                <>
                  <h3 className="text-[14px] font-semibold text-[var(--foreground)]">
                    {tr("packages.installedSection")}
                  </h3>
                  <div className="item-list" data-testid="packages-list">
                    {updatesChecked ? (
                      <p className="form-hint m-0" data-testid="packages-update-summary">
                        {updateSources.size === 0
                          ? tr("packages.updateCheckedNone")
                          : tr("packages.updateAvailableCount", {
                              n: String(updateSources.size),
                            })}
                      </p>
                    ) : null}
                    {props.packages.map((item) => {
                      const hasUpdate = updateSources.has(item.source);
                      return (
                        <article
                          key={`${item.scope}:${item.source}`}
                          className="item-card"
                          data-enabled={item.enabled ? "true" : "false"}
                          data-update={hasUpdate ? "true" : "false"}
                          data-testid={`package-card-${item.scope}-${item.source}`}
                        >
                          <div className="min-w-0">
                            <div className="title">{item.source}</div>
                            <div className="meta">
                              {item.installedPath ? item.installedPath : tr("packages.notResolved")}
                              {item.filtered ? ` · ${tr("packages.filtered")}` : ""}
                            </div>
                          </div>
                          <div className="badges">
                            <span
                              className="chip-status"
                              data-tone={item.enabled ? "on" : "off"}
                              data-testid={`package-status-${item.scope}-${item.source}`}
                            >
                              {item.enabled ? tr("packages.enabled") : tr("packages.disabled")}
                            </span>
                            {hasUpdate ? (
                              <span className="chip-status" data-tone="update">
                                {tr("packages.updateAvailable")}
                              </span>
                            ) : null}
                            <span className="chip">{item.scope}</span>
                            <span className="chip">{item.kind}</span>
                            <button
                              type="button"
                              className="btn-secondary btn-sm"
                              data-testid={`package-enable-${item.scope}-${item.source}`}
                              disabled={props.loading || busy}
                              onClick={() =>
                                void props.onSetEnabled(item.source, item.scope, !item.enabled)
                              }
                            >
                              {item.enabled ? tr("packages.disable") : tr("packages.enable")}
                            </button>
                            {item.kind !== "local" ? (
                              <button
                                type="button"
                                className="btn-secondary btn-sm"
                                data-testid={`package-update-${item.scope}-${item.source}`}
                                disabled={
                                  props.loading || busy || (updatesChecked ? !hasUpdate : false)
                                }
                                title={
                                  updatesChecked && !hasUpdate
                                    ? tr("packages.upToDate")
                                    : tr("packages.update")
                                }
                                onClick={() => void runUpdate(item.source)}
                              >
                                {updatesChecked && !hasUpdate
                                  ? tr("packages.upToDate")
                                  : tr("packages.update")}
                              </button>
                            ) : null}
                            <button
                              type="button"
                              className="btn-ghost btn-sm danger"
                              data-testid={`package-remove-${item.scope}-${item.source}`}
                              disabled={props.loading || busy}
                              onClick={() => void props.onRemove(item.source, item.scope)}
                            >
                              {tr("packages.remove")}
                            </button>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </>
              )}

              <McpServersSection
                locale={props.locale}
                servers={mcpServers}
                dirty={mcpDirty}
                busy={busy}
                onSetEnabled={(name, enabled) => void setMcpEnabled(name, enabled)}
                onUpdate={(name) => void updateMcp(name)}
                onRemove={(name) => void removeMcp(name)}
              />
            </>
          )}
        </div>
      </div>
    </section>
  );
}
