/**
 * Settings → «Память» (research/18 §6.7, S5; research/24 §3.6): «Запоминать, когда я прошу» and
 * «Замечать важное само», what the agent remembers «Обо мне» and «Об этом проекте» — each with
 * «вы просили / заметил сам», the date and the owner's words, [Закрепить] and [Забыть] —, «Что было
 * в прошлый раз», «Было» (replaced, expired, forgotten) and «Недавно забыто» with «Вернуть», and
 * «Забыть всё» behind a ConfirmDialog.
 */
import type { HarnessFlags, MemoryItem, MemorySnapshot } from "@zeno/contracts";
import { useCallback, useEffect, useState } from "react";
import { localeTag, type Locale, type MessageKey } from "../../lib/i18n.ts";
import {
  autoIntroSeen,
  errorText,
  markAutoIntroSeen,
  memoryApi,
  memoryDate,
} from "../../lib/memory.ts";
import { ConfirmDialog } from "../ConfirmDialog.tsx";
import "../code-preview-features.css";
import {
  SettingsPageShell,
  SettingsPillButton,
  SettingsRow,
  SettingsSectionBlock,
  SettingsToggle,
} from "./SettingsPrimitives.tsx";

type Tr = (key: MessageKey, vars?: Record<string, string>) => string;

function Entries(props: {
  tr: Tr;
  label: string;
  testId: string;
  items: { id: string; text: string }[];
  action: "forget" | "restore";
  busy: boolean;
  onAction: (id: string) => void;
}) {
  const { tr } = props;
  return (
    <SettingsSectionBlock label={props.label} testId={props.testId}>
      {props.items.length === 0 ? (
        <SettingsRow title={tr("features.memory.empty")} control={null} last />
      ) : (
        props.items.map((item, index) => (
          <SettingsRow
            key={item.id}
            title={item.text}
            testId={`${props.testId}-row`}
            last={index === props.items.length - 1}
            control={
              <SettingsPillButton
                label={tr(
                  props.action === "forget" ? "features.memory.forget" : "features.memory.restore",
                )}
                testId={`${props.testId}-${props.action}`}
                disabled={props.busy}
                danger={props.action === "forget"}
                onClick={() => props.onAction(item.id)}
              />
            }
          />
        ))
      )}
    </SettingsSectionBlock>
  );
}

/** «вы просили · 12 окт. · Ваши слова: «…»» — what a v2 entry knows about itself. */
function entryDescription(tr: Tr, locale: Locale, item: MemoryItem): string | undefined {
  const parts = [
    item.origin
      ? tr(item.origin === "auto" ? "features.memory.origin.auto" : "features.memory.origin.user")
      : "",
    memoryDate(localeTag(locale), item.created),
    item.quote ? tr("features.memory.quote", { quote: item.quote }) : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : undefined;
}

/** What the agent remembers, with [Закрепить]/[Открепить] (v2) and [Забыть]. */
function Remembered(props: {
  tr: Tr;
  locale: Locale;
  label: string;
  testId: string;
  items: MemoryItem[];
  busy: boolean;
  canPin: boolean;
  onForget: (id: string) => void;
  onPin: (id: string, pinned: boolean) => void;
}) {
  const { tr } = props;
  return (
    <SettingsSectionBlock label={props.label} testId={props.testId}>
      {props.items.length === 0 ? (
        <SettingsRow title={tr("features.memory.empty")} control={null} last />
      ) : (
        props.items.map((item, index) => (
          <SettingsRow
            key={item.id}
            title={item.text}
            description={entryDescription(tr, props.locale, item)}
            testId={`${props.testId}-row`}
            last={index === props.items.length - 1}
            control={
              <div className="memory-row-actions">
                {props.canPin ? (
                  <SettingsPillButton
                    label={tr(item.pinned ? "features.memory.unpin" : "features.memory.pin")}
                    testId={`${props.testId}-pin`}
                    disabled={props.busy}
                    onClick={() => props.onPin(item.id, !item.pinned)}
                  />
                ) : null}
                <SettingsPillButton
                  label={tr("features.memory.forget")}
                  testId={`${props.testId}-forget`}
                  disabled={props.busy}
                  danger
                  onClick={() => props.onForget(item.id)}
                />
              </div>
            }
          />
        ))
      )}
    </SettingsSectionBlock>
  );
}

export function MemorySection(props: { tr: Tr; locale: Locale; workspace: string | undefined }) {
  const { tr, workspace } = props;
  const api = memoryApi();
  const [flags, setFlags] = useState<HarnessFlags | undefined>();
  const enabled = flags?.memory;
  /** The first time «Замечать важное само» goes on: a card with [Выключить] (§3.6). */
  const [autoIntro, setAutoIntro] = useState(false);
  const [snapshot, setSnapshot] = useState<MemorySnapshot | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    let alive = true;
    void Promise.resolve(window.zeno.harnessFlags?.get())
      .then((next) => alive && next && setFlags(next))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!api) return;
    let alive = true;
    api
      .list(workspace)
      .then((next) => alive && setSnapshot(next))
      .catch((e: unknown) => alive && setError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [api, workspace]);

  async function setFlag(patch: Partial<HarnessFlags>) {
    const before = flags;
    if (flags) setFlags({ ...flags, ...patch });
    try {
      setFlags(await window.zeno.harnessFlags.set(patch));
    } catch {
      setFlags(before);
    }
  }

  const run = useCallback(async (call: () => Promise<MemorySnapshot>) => {
    setBusy(true);
    setError(undefined);
    try {
      setSnapshot(await call());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }, []);

  // [Закрепить] only once core serves memory v2 (entries know their origin or pin).
  const canPin = Boolean(
    snapshot &&
    [...snapshot.user, ...snapshot.project].some(
      (item) => item.origin !== undefined || item.pinned !== undefined,
    ),
  );

  return (
    <SettingsPageShell title={tr("features.memory.section")} testId="settings-memory">
      <p className="memory-note" data-testid="memory-hint">
        {tr("features.memory.hint")}
      </p>
      <SettingsSectionBlock label={tr("features.memory.section")} showLabel={false}>
        <SettingsRow
          title={tr("features.memory.toggle")}
          description={tr(enabled === false ? "features.memory.off" : "features.memory.toggleHint")}
          control={
            <SettingsToggle
              checked={enabled ?? false}
              disabled={enabled === undefined}
              onChange={(on) => void setFlag({ memory: on })}
              testId="settings-memory-toggle"
              aria-label={tr("features.memory.toggle")}
            />
          }
        />
        <SettingsRow
          title={tr("features.memory.autoToggle")}
          description={tr(
            flags?.autoMemory === "shadow"
              ? "features.memory.autoShadow"
              : "features.memory.autoToggleHint",
          )}
          last
          control={
            <SettingsToggle
              checked={flags?.autoMemory === true}
              disabled={!enabled}
              onChange={(on) => {
                void setFlag({ autoMemory: on ? true : "off" });
                if (on && !autoIntroSeen()) {
                  markAutoIntroSeen();
                  setAutoIntro(true);
                }
                if (!on) setAutoIntro(false);
              }}
              testId="settings-memory-auto-toggle"
              aria-label={tr("features.memory.autoToggle")}
            />
          }
        />
      </SettingsSectionBlock>
      {autoIntro ? (
        <div className="memory-auto-intro" role="status" data-testid="memory-auto-intro">
          <span>{tr("features.memory.autoFirst")}</span>
          <SettingsPillButton
            label={tr("features.memory.autoOff")}
            testId="memory-auto-intro-off"
            onClick={() => {
              setAutoIntro(false);
              void setFlag({ autoMemory: "off" });
            }}
          />
        </div>
      ) : null}
      {error ? (
        <p className="memory-note" role="alert" data-testid="memory-error">
          {tr("features.memory.failed", { error })}
        </p>
      ) : null}
      {!api ? (
        <p className="memory-note" data-testid="memory-unavailable">
          {tr("features.memory.unavailable")}
        </p>
      ) : snapshot ? (
        <>
          <Remembered
            tr={tr}
            locale={props.locale}
            label={tr("features.memory.user")}
            testId="memory-user"
            items={snapshot.user}
            busy={busy}
            canPin={canPin}
            onForget={(id) => void run(() => api.forget(id, workspace))}
            onPin={(id, pinned) => void run(() => api.pin(id, pinned, workspace))}
          />
          {workspace ? (
            <Remembered
              tr={tr}
              locale={props.locale}
              label={tr("features.memory.project")}
              testId="memory-project"
              items={snapshot.project}
              busy={busy}
              canPin={canPin}
              onForget={(id) => void run(() => api.forget(id, workspace))}
              onPin={(id, pinned) => void run(() => api.pin(id, pinned, workspace))}
            />
          ) : (
            <SettingsSectionBlock label={tr("features.memory.project")} testId="memory-project">
              <SettingsRow title={tr("features.memory.noProject")} control={null} last />
            </SettingsSectionBlock>
          )}
          {snapshot.digest ? (
            <SettingsSectionBlock label={tr("features.memory.digest")} testId="memory-digest">
              <SettingsRow title={snapshot.digest.text} control={null} last />
            </SettingsSectionBlock>
          ) : null}
          {snapshot.history?.length ? (
            <SettingsSectionBlock label={tr("features.memory.history")} testId="memory-history">
              {snapshot.history.map((item, index) => (
                <SettingsRow
                  key={item.opId}
                  title={item.text}
                  description={[
                    item.kind === "replaced"
                      ? tr("features.memory.history.replaced", { now: item.now ?? "" })
                      : tr(
                          item.kind === "expired"
                            ? "features.memory.history.expired"
                            : "features.memory.history.forgotten",
                        ),
                    memoryDate(localeTag(props.locale), item.at),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  testId="memory-history-row"
                  last={index === (snapshot.history?.length ?? 0) - 1}
                  control={
                    <SettingsPillButton
                      label={tr("features.memory.restore")}
                      testId="memory-history-revert"
                      disabled={busy}
                      onClick={() => void run(() => api.revert(item.opId, workspace))}
                    />
                  }
                />
              ))}
            </SettingsSectionBlock>
          ) : null}
          {snapshot.forgotten.length > 0 ? (
            <Entries
              tr={tr}
              label={tr("features.memory.forgotten")}
              testId="memory-forgotten"
              items={snapshot.forgotten}
              action="restore"
              busy={busy}
              onAction={(id) => void run(() => api.restore(id, workspace))}
            />
          ) : null}
          <div className="memory-forget-all">
            <SettingsPillButton
              label={tr("features.memory.forgetAll")}
              testId="memory-forget-all"
              danger
              disabled={busy || (snapshot.user.length === 0 && snapshot.project.length === 0)}
              onClick={() => setConfirming(true)}
            />
          </div>
        </>
      ) : null}
      <ConfirmDialog
        open={confirming}
        title={tr("features.memory.confirmTitle")}
        message={tr("features.memory.confirmMessage")}
        confirmLabel={tr("features.memory.forgetAll")}
        cancelLabel={tr("common.cancel")}
        danger
        testId="memory-forget-all-confirm"
        onConfirm={() => {
          setConfirming(false);
          if (api) void run(() => api.forgetAll());
        }}
        onCancel={() => setConfirming(false)}
      />
    </SettingsPageShell>
  );
}
