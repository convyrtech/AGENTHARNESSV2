/**
 * Settings → «Поиск в интернете» (issue #23, research/26 §3.7): «Искать в интернете» (harness flag
 * `webTools`), which search goes first — free by default, own keys, the PRSLOY gateway, the model's own
 * last —, «Проверить» from the user's network with the date of the last check, and where to get a key.
 * Keys go to main once and come back only as a mask; the field is cleared right after saving.
 */
import type {
  HarnessFlags,
  SearchApi,
  SearchCheckResult,
  SearchProviderId,
  SearchProviderState,
  SearchState,
} from "@zeno/contracts";
import { useEffect, useState } from "react";
import { localeTag, type Locale, type MessageKey } from "../../lib/i18n.ts";
import { errorText } from "../../lib/memory.ts";
import {
  activeProvider,
  checkLine,
  HINTS_CHECKED_ON,
  hintKey,
  lastCheckLine,
  nameKey,
  orderedProviders,
  searchForm,
  takeKeyFormRequest,
} from "../../lib/search-settings.ts";
import "../code-preview-features.css";
import {
  SettingsButton,
  SettingsInput,
  SettingsPageShell,
  SettingsRow,
  SettingsSectionBlock,
  SettingsToggle,
} from "./SettingsPrimitives.tsx";

type Tr = (key: MessageKey, vars?: Record<string, string>) => string;

type Draft = { key: string; folderId: string; url: string };
const EMPTY_DRAFT: Draft = { key: "", folderId: "", url: "" };

function searchApi(): SearchApi | undefined {
  return (window.zeno as { search?: SearchApi } | undefined)?.search;
}

function KeyForm(props: {
  tr: Tr;
  provider: SearchProviderState;
  busy: boolean;
  onSave: (draft: Draft) => void;
  onCancel: () => void;
}) {
  const { tr, provider } = props;
  const form = searchForm(provider.id);
  const [draft, setDraft] = useState<Draft>({
    ...EMPTY_DRAFT,
    folderId: provider.fields?.folderId ?? "",
    url: provider.fields?.url ?? "",
  });
  const ready =
    form === "url"
      ? draft.url.trim() !== ""
      : draft.key.trim() !== "" && (form !== "keyFolder" || draft.folderId.trim() !== "");
  function submit() {
    if (!ready) return;
    props.onSave(draft);
    // The key leaves the renderer once: nothing keeps it after the call.
    setDraft((d) => ({ ...d, key: "" }));
  }
  return (
    // A group, not a <form>: the row's description is a <p>. Enter in any field saves.
    <span
      role="group"
      aria-label={tr(nameKey(provider.id))}
      className="web-search-form"
      data-testid="web-search-form"
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        submit();
      }}
    >
      {form === "url" ? (
        <SettingsInput
          autoFocus
          type="url"
          className="w-56"
          spellCheck={false}
          placeholder="https://"
          aria-label={tr("features.web.urlLabel")}
          data-testid="web-search-url"
          value={draft.url}
          disabled={props.busy}
          onChange={(e) => setDraft({ ...draft, url: e.target.value })}
        />
      ) : (
        <SettingsInput
          autoFocus
          type="password"
          autoComplete="off"
          spellCheck={false}
          className="w-56"
          placeholder={tr("features.web.keyPlaceholder")}
          aria-label={tr("features.web.keyLabel")}
          data-testid="web-search-key"
          value={draft.key}
          disabled={props.busy}
          onChange={(e) => setDraft({ ...draft, key: e.target.value })}
        />
      )}
      {form === "keyFolder" ? (
        <SettingsInput
          className="w-40"
          spellCheck={false}
          placeholder={tr("features.web.folderLabel")}
          aria-label={tr("features.web.folderLabel")}
          data-testid="web-search-folder"
          value={draft.folderId}
          disabled={props.busy}
          onChange={(e) => setDraft({ ...draft, folderId: e.target.value })}
        />
      ) : null}
      <SettingsButton
        type="button"
        disabled={props.busy || !ready}
        testId="web-search-save"
        onClick={submit}
      >
        {tr("features.web.save")}
      </SettingsButton>
      <SettingsButton type="button" variant="ghost" disabled={props.busy} onClick={props.onCancel}>
        {tr("features.web.cancel")}
      </SettingsButton>
    </span>
  );
}

export function SearchSection(props: { tr: Tr; locale: Locale }) {
  const { tr } = props;
  const api = searchApi();
  const [flags, setFlags] = useState<HarnessFlags | undefined>();
  const [state, setState] = useState<SearchState | undefined>();
  // «Добавить ключ» on the chat card opens this page with that provider's form open.
  const [editing, setEditing] = useState<SearchProviderId | undefined>();
  useEffect(() => {
    const id = takeKeyFormRequest();
    if (id) setEditing(id);
  }, []);
  const [busy, setBusy] = useState<SearchProviderId | undefined>();
  const [checks, setChecks] = useState<Partial<Record<SearchProviderId, SearchCheckResult>>>({});
  const [error, setError] = useState<{ id?: SearchProviderId; text: string } | undefined>();

  useEffect(() => {
    let alive = true;
    void Promise.resolve(window.zeno.harnessFlags?.get())
      .then((next) => alive && next && setFlags(next))
      .catch(() => undefined);
    void Promise.resolve(api?.getState())
      .then((next) => alive && next && setState(next))
      .catch((e: unknown) => alive && setError({ text: errorText(e) }));
    return () => {
      alive = false;
    };
  }, [api]);

  async function setWebTools(next: boolean) {
    const before = flags;
    if (flags) setFlags({ ...flags, webTools: next });
    try {
      setFlags(await window.zeno.harnessFlags.set({ webTools: next }));
    } catch {
      setFlags(before);
    }
  }

  async function run(id: SearchProviderId, call: () => Promise<SearchState>) {
    setBusy(id);
    setError(undefined);
    try {
      setState(await call());
      setChecks(({ [id]: _old, ...rest }) => rest);
      return true;
    } catch (e) {
      setError({ id, text: errorText(e) });
      return false;
    } finally {
      setBusy(undefined);
    }
  }

  async function save(id: SearchProviderId, draft: Draft) {
    if (!api) return;
    const form = searchForm(id);
    const fields =
      form === "url"
        ? { url: draft.url.trim() }
        : form === "keyFolder"
          ? { folderId: draft.folderId.trim() }
          : undefined;
    const key = form === "url" ? "" : draft.key.trim();
    if (await run(id, () => api.setKey(id, key, fields))) setEditing(undefined);
  }

  async function check(id: SearchProviderId) {
    if (!api) return;
    setBusy(id);
    setError(undefined);
    try {
      const result = await api.check(id);
      setChecks((c) => ({ ...c, [id]: result }));
      // main stored the result as lastCheck; refresh so the row keeps it after the fresh line goes.
      setState(await api.getState());
    } catch (e) {
      setError({ id, text: errorText(e) });
    } finally {
      setBusy(undefined);
    }
  }

  const active = state ? activeProvider(state) : undefined;
  const tag = localeTag(props.locale);
  const checkedOn = new Date(`${HINTS_CHECKED_ON}T12:00:00`).toLocaleDateString(tag, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  function description(p: SearchProviderState) {
    const status =
      p.id === "prsloy" || p.id === "model"
        ? p.configured
          ? undefined
          : tr("features.web.needsPrsloy")
        : p.keyMask
          ? tr("features.web.keySaved", { mask: p.keyMask })
          : p.fields?.url
            ? tr("features.web.urlSaved", { url: p.fields.url })
            : undefined;
    const fresh = checks[p.id];
    const result = fresh ? checkLine(tr, fresh) : lastCheckLine(tr, tag, p.lastCheck);
    return (
      <>
        <span className="web-search-hint">{tr(hintKey(p.id))}</span>
        {status ? <span className="web-search-status">{status}</span> : null}
        {result ? (
          <span
            className="web-search-status"
            data-testid="web-search-result"
            data-ok={(fresh ? fresh.ok : p.lastCheck?.ok) ? "true" : "false"}
          >
            {result}
          </span>
        ) : null}
        {error?.id === p.id ? (
          <span className="text-[var(--destructive)]" role="alert">
            {tr("features.web.failed", { error: error.text })}
          </span>
        ) : null}
        {actions(p)}
      </>
    );
  }

  /** «Сейчас этот» or «Выбрать», on the right of the row. */
  function choice(p: SearchProviderState) {
    if (active === p.id) {
      return (
        <span className="web-search-active" data-testid="web-search-active">
          {tr("features.web.active")}
        </span>
      );
    }
    if (!p.configured) return null;
    return (
      <SettingsButton
        testId="web-search-use"
        disabled={busy !== undefined}
        onClick={() => api && void run(p.id, () => api.setActive(p.id))}
      >
        {tr("features.web.use")}
      </SettingsButton>
    );
  }

  /** «Проверить», the key or address form, «Убрать» — under the hint, so long hints never run under them. */
  function actions(p: SearchProviderState) {
    if (editing === p.id) {
      return (
        <KeyForm
          tr={tr}
          provider={p}
          busy={busy === p.id}
          onSave={(draft) => void save(p.id, draft)}
          onCancel={() => setEditing(undefined)}
        />
      );
    }
    const form = searchForm(p.id);
    const isBusy = busy !== undefined;
    return (
      <span className="web-search-actions">
        {p.configured ? (
          <SettingsButton
            testId="web-search-check"
            variant="ghost"
            disabled={isBusy}
            onClick={() => void check(p.id)}
          >
            {busy === p.id ? tr("features.web.checking") : tr("features.web.check")}
          </SettingsButton>
        ) : null}
        {form !== "none" ? (
          <SettingsButton
            testId="web-search-edit"
            variant="ghost"
            disabled={isBusy}
            onClick={() => {
              setError(undefined);
              setEditing(p.id);
            }}
          >
            {p.configured
              ? tr("features.web.change")
              : tr(form === "url" ? "features.web.addUrl" : "features.web.addKey")}
          </SettingsButton>
        ) : null}
        {form !== "none" && p.configured ? (
          <SettingsButton
            testId="web-search-remove"
            variant="ghost"
            danger
            disabled={isBusy}
            onClick={() => api && void run(p.id, () => api.clearKey(p.id))}
          >
            {tr("features.web.remove")}
          </SettingsButton>
        ) : null}
      </span>
    );
  }

  const providers = state ? orderedProviders(state) : [];
  return (
    <SettingsPageShell title={tr("features.web.section")} testId="settings-web-search">
      <p className="memory-note" data-testid="web-search-intro">
        {tr("features.web.intro")}
      </p>
      <SettingsSectionBlock
        label={tr("features.web.section")}
        showLabel={false}
        testId="web-search-switch"
      >
        <SettingsRow
          title={tr("features.web.enable")}
          description={tr("features.web.enableHint")}
          last
          control={
            <SettingsToggle
              testId="web-search-toggle"
              checked={flags?.webTools === true}
              disabled={!flags}
              onChange={(next) => void setWebTools(next)}
            />
          }
        />
      </SettingsSectionBlock>
      <SettingsSectionBlock label={tr("features.web.group")} testId="web-search-providers">
        {providers.map((p, index) => (
          <SettingsRow
            key={p.id}
            testId={`web-search-${p.id}`}
            title={tr(nameKey(p.id))}
            description={description(p)}
            control={choice(p)}
            last={index === providers.length - 1}
          />
        ))}
      </SettingsSectionBlock>
      {error && !error.id ? (
        <p className="memory-note" role="alert" data-testid="web-search-error">
          {tr("features.web.failed", { error: error.text })}
        </p>
      ) : null}
      <p className="memory-note web-search-footnote">{tr("features.web.chainHint")}</p>
      <p className="memory-note web-search-footnote" data-testid="web-search-checked-on">
        {tr("features.web.hintsChecked", { date: checkedOn })}
      </p>
    </SettingsPageShell>
  );
}
