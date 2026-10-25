/**
 * Settings → «Память» (research/18 §6.7, S5): «Запоминать, когда я прошу», what the agent
 * remembers «Обо мне» and «Об этом проекте», «Что было в прошлый раз», «Забыть» per entry,
 * «Недавно забыто» with «Вернуть», and «Забыть всё» behind a ConfirmDialog.
 */
import type { MemorySnapshot } from "@zeno/contracts";
import { useCallback, useEffect, useState } from "react";
import type { MessageKey } from "../../lib/i18n.ts";
import { errorText, memoryApi } from "../../lib/memory.ts";
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

export function MemorySection(props: { tr: Tr; workspace: string | undefined }) {
  const { tr, workspace } = props;
  const api = memoryApi();
  const [enabled, setEnabled] = useState<boolean | undefined>();
  const [snapshot, setSnapshot] = useState<MemorySnapshot | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    let alive = true;
    void Promise.resolve(window.zeno.harnessFlags?.get())
      .then((flags) => alive && flags && setEnabled(flags.memory))
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

  return (
    <SettingsPageShell title={tr("features.memory.section")} testId="settings-memory">
      <p className="memory-note" data-testid="memory-hint">
        {tr("features.memory.hint")}
      </p>
      <SettingsSectionBlock label={tr("features.memory.section")} showLabel={false}>
        <SettingsRow
          title={tr("features.memory.toggle")}
          description={tr(enabled === false ? "features.memory.off" : "features.memory.toggleHint")}
          last
          control={
            <SettingsToggle
              checked={enabled ?? false}
              disabled={enabled === undefined}
              onChange={(on) => {
                setEnabled(on);
                void window.zeno.harnessFlags
                  .set({ memory: on })
                  .then((flags) => setEnabled(flags.memory))
                  .catch(() => setEnabled(!on));
              }}
              testId="settings-memory-toggle"
              aria-label={tr("features.memory.toggle")}
            />
          }
        />
      </SettingsSectionBlock>
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
          <Entries
            tr={tr}
            label={tr("features.memory.user")}
            testId="memory-user"
            items={snapshot.user}
            action="forget"
            busy={busy}
            onAction={(id) => void run(() => api.forget(id, workspace))}
          />
          {workspace ? (
            <Entries
              tr={tr}
              label={tr("features.memory.project")}
              testId="memory-project"
              items={snapshot.project}
              action="forget"
              busy={busy}
              onAction={(id) => void run(() => api.forget(id, workspace))}
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
