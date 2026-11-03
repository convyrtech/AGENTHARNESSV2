import type { CuaOwnerResolution, CuaRecoveryItem } from "@zeno/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Locale } from "../lib/i18n.ts";
import { CuaRecoveryDialog, cuaRecoveryBannerLabel } from "./CuaRecoveryDialog.tsx";

const listTimeoutMs = 10_000;
const maxOutstandingLists = 2;

function listTimeoutMessage(locale: Locale) {
  if (locale === "ru") return "Истекло время ожидания списка действий (10 секунд)";
  if (locale === "zh") return "等待恢复队列超时（10 秒）";
  return "Timed out waiting for the recovery queue (10 seconds)";
}

function listLimitMessage(locale: Locale) {
  if (locale === "ru")
    return "Слишком много незавершённых запросов к очереди; ожидаю их завершения";
  if (locale === "zh") return "未完成的队列请求过多；等待它们完成";
  return "Too many unfinished recovery queue requests; waiting for them to finish";
}

/** Owns the recovery queue polling, owner decisions, banner, and confirmation dialog. */
export function CuaRecoveryController({ locale }: { locale: Locale }) {
  const [items, setItems] = useState<CuaRecoveryItem[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [listError, setListError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const listSequence = useRef(0);
  const listInFlight = useRef(false);
  const outstandingLists = useRef(0);
  const mounted = useRef(false);
  const error = actionError ?? listError;
  const selected = items.find((item) => item.actionId === selectedId);

  const refreshItems = useCallback(
    async (force = false) => {
      if (listInFlight.current && !force) return;
      if (outstandingLists.current >= maxOutstandingLists) {
        // A forced refresh may have invalidated the current logical request. If no IPC slot is
        // available, release its poll lock so a later interval can retry after a slot frees up.
        if (force) listInFlight.current = false;
        if (mounted.current) setListError(listLimitMessage(locale));
        return;
      }
      const sequence = ++listSequence.current;
      listInFlight.current = true;
      let timeout: number | undefined;
      try {
        const listPromise = window.zeno.prsloy.cuaRecovery.list();
        outstandingLists.current++;
        const releaseTransportSlot = () => {
          outstandingLists.current = Math.max(0, outstandingLists.current - 1);
        };
        void listPromise.then(releaseTransportSlot, releaseTransportSlot);
        const nextItems = await Promise.race([
          listPromise,
          new Promise<CuaRecoveryItem[]>((_, reject) => {
            timeout = window.setTimeout(
              () => reject(new Error(listTimeoutMessage(locale))),
              listTimeoutMs,
            );
          }),
        ]);
        if (!mounted.current || sequence !== listSequence.current) return;
        setItems(nextItems);
        setListError(undefined);
        setSelectedId((current) =>
          current && nextItems.some((item) => item.actionId === current) ? current : undefined,
        );
      } catch (cause) {
        if (mounted.current && sequence === listSequence.current) {
          setListError(cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        if (timeout !== undefined) window.clearTimeout(timeout);
        if (sequence === listSequence.current) {
          listInFlight.current = false;
        }
      }
    },
    [locale],
  );

  useEffect(() => {
    mounted.current = true;
    void refreshItems();
    const timer = window.setInterval(() => void refreshItems(), 3_000);
    return () => {
      mounted.current = false;
      listSequence.current++;
      listInFlight.current = false;
      window.clearInterval(timer);
    };
  }, [refreshItems]);

  async function resolve(resolution: CuaOwnerResolution, actionId: string, challenge: string) {
    setBusy(true);
    setActionError(undefined);
    try {
      await window.zeno.prsloy.cuaRecovery.resolve(actionId, challenge, resolution);
      if (!mounted.current) return;
      // Any list started before the owner decision is now stale.
      listSequence.current++;
      setSelectedId(undefined);
      setActionError(undefined);
      await refreshItems(true);
    } catch (cause) {
      if (mounted.current) setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function acceptInFlightRisk(actionId: string, challenge: string) {
    setBusy(true);
    setActionError(undefined);
    try {
      await window.zeno.prsloy.cuaRecovery.acceptInFlightRisk(actionId, challenge);
      if (!mounted.current) return;
      // Any list started before the owner decision is now stale.
      listSequence.current++;
      setSelectedId(undefined);
      setActionError(undefined);
      await refreshItems(true);
    } catch (cause) {
      if (mounted.current) setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <>
      {items.length > 0 || error ? (
        <div className="fixed top-16 right-4 z-[120] flex max-w-[min(28rem,calc(100vw-2rem))] flex-col items-end gap-2">
          {error ? (
            <p
              className="m-0 rounded-md bg-destructive px-3 py-2 text-xs text-destructive-foreground"
              role="alert"
            >
              {error}
            </p>
          ) : null}
          {items.length > 0 ? (
            <button
              type="button"
              data-testid="cua-recovery-open"
              className="rounded-md border bg-background px-3 py-2 text-sm shadow-lg"
              onClick={() => setSelectedId(items[0]?.actionId)}
            >
              {cuaRecoveryBannerLabel(items, locale)}
            </button>
          ) : null}
        </div>
      ) : null}
      {selected ? (
        <CuaRecoveryDialog
          open
          pending={selected}
          locale={locale}
          busy={busy}
          {...(error ? { error } : {})}
          onLeaveBlocked={() => setSelectedId(undefined)}
          onResolve={(resolution, actionId, challenge) =>
            void resolve(resolution, actionId, challenge)
          }
          onAcceptInFlightRisk={(actionId, challenge) =>
            void acceptInFlightRisk(actionId, challenge)
          }
        />
      ) : null}
    </>
  );
}
