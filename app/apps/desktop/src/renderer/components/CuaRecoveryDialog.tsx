import { useEffect, useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { localeTag, t, type Locale } from "../lib/i18n.ts";

export type CuaRecoveryResolution =
  | "observed_completed"
  | "observed_not_applied"
  | "accept_unknown";
type CuaRecoveryBackend = "cua" | "munim";

type CuaRecoveryPendingActionBase = {
  actionId: string;
  pid: number;
  kind: "click" | "type_text" | "other";
  status: "dispatching" | "unknown";
  createdAt: number;
  challenge: string;
};

export type CuaRecoveryPendingAction = CuaRecoveryPendingActionBase &
  ({ backend?: "cua"; windowId: number } | { backend: "munim"; windowId: null });

export function cuaRecoveryBannerLabel(
  items: { backend?: CuaRecoveryBackend }[],
  locale: Locale,
): string {
  if (items.length === 0) return "";
  const hasCua = items.some((item) => item.backend !== "munim");
  const hasMunim = items.some((item) => item.backend === "munim");
  const count = items.length;
  if (hasCua && !hasMunim) return t(locale, "cuaRecovery.bannerCua", { count: String(count) });
  if (hasMunim && !hasCua) return t(locale, "cuaRecovery.bannerMunim", { count: String(count) });
  return t(locale, "cuaRecovery.bannerMixed", { count: String(count) });
}

function formatTime(createdAt: number, locale: Locale): string {
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime())) return t(locale, "cuaRecovery.unknownTime");
  return new Intl.DateTimeFormat(localeTag(locale), {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function CuaRecoveryDialog(props: {
  open: boolean;
  pending: CuaRecoveryPendingAction;
  locale: Locale;
  busy?: boolean;
  error?: string;
  onLeaveBlocked: () => void;
  onResolve: (resolution: CuaRecoveryResolution, actionId: string, challenge: string) => void;
  onAcceptInFlightRisk: (actionId: string, challenge: string) => void;
}) {
  const settledRef = useRef(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [acknowledgedInFlight, setAcknowledgedInFlight] = useState(false);
  useEffect(() => {
    setAcknowledged(false);
    setAcknowledgedInFlight(false);
  }, [props.open, props.pending.actionId]);
  const locale = props.locale;
  const busy = props.busy === true;
  const backendName = props.pending.backend === "munim" ? "Munim" : "Cua";
  // A dispatch still owned by a live host cannot be resolved as a lost result.
  const resolvingDisabled = busy || props.pending.status === "dispatching" || !acknowledged;
  const actionName =
    props.pending.kind === "click"
      ? t(locale, "cuaRecovery.action.click")
      : props.pending.kind === "type_text"
        ? t(locale, "cuaRecovery.action.typeText")
        : t(locale, "cuaRecovery.action.other");
  const targetDescription =
    props.pending.backend === "munim"
      ? t(locale, "cuaRecovery.targetMunim", {
          pid: String(props.pending.pid),
          action: actionName,
          time: formatTime(props.pending.createdAt, locale),
        })
      : t(locale, "cuaRecovery.targetCua", {
          pid: String(props.pending.pid),
          windowId: String(props.pending.windowId),
          action: actionName,
          time: formatTime(props.pending.createdAt, locale),
        });

  function resolve(resolution: CuaRecoveryResolution) {
    settledRef.current = true;
    props.onResolve(resolution, props.pending.actionId, props.pending.challenge);
  }

  return (
    <AlertDialog
      open={props.open}
      onOpenChange={(open) => {
        if (open) {
          settledRef.current = false;
          return;
        }
        if (!settledRef.current && !busy) props.onLeaveBlocked();
      }}
    >
      <AlertDialogContent
        size="default"
        className="max-w-lg gap-3 p-4"
        data-testid="cua-recovery-dialog"
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="text-[15px] font-semibold">
            {t(locale, "cuaRecovery.title")}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-[13px] leading-relaxed text-muted-foreground">
              <p className="m-0">{t(locale, "cuaRecovery.lostResult", { backend: backendName })}</p>
              <p className="m-0">{targetDescription}</p>
              <p
                className="m-0 rounded-md bg-muted/60 px-2 py-1.5 font-mono text-[11px] break-all"
                data-testid="cua-recovery-action-id"
              >
                {props.pending.actionId}
              </p>
              <p className="m-0 font-medium text-foreground">
                {t(locale, "cuaRecovery.keepGateClosed")}
              </p>
              {props.pending.status === "dispatching" ? (
                <p className="m-0 font-medium text-foreground">
                  {t(locale, "cuaRecovery.dispatchingWarning", { backend: backendName })}
                </p>
              ) : null}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {props.pending.status === "dispatching" ? (
          <div className="grid gap-2">
            <label className="flex items-start gap-2 text-[13px]">
              <input
                type="checkbox"
                checked={acknowledgedInFlight}
                disabled={busy}
                onChange={(event) => setAcknowledgedInFlight(event.target.checked)}
                data-testid="cua-recovery-acknowledge-in-flight"
              />
              <span>{t(locale, "cuaRecovery.acknowledgeInFlight")}</span>
            </label>
            <Button
              type="button"
              variant="destructive"
              disabled={busy || !acknowledgedInFlight}
              data-testid="cua-recovery-accept-in-flight"
              onClick={() =>
                props.onAcceptInFlightRisk(props.pending.actionId, props.pending.challenge)
              }
            >
              {t(locale, "cuaRecovery.acceptInFlight")}
            </Button>
          </div>
        ) : null}
        <label className="flex items-start gap-2 text-[13px]">
          <input
            type="checkbox"
            checked={acknowledged}
            disabled={busy || props.pending.status === "dispatching"}
            onChange={(event) => setAcknowledged(event.target.checked)}
            data-testid="cua-recovery-acknowledge"
          />
          <span>{t(locale, "cuaRecovery.acknowledgeUnknown")}</span>
        </label>
        <div className="grid gap-2">
          <Button
            type="button"
            variant="default"
            disabled={resolvingDisabled}
            data-testid="cua-recovery-completed"
            onClick={() => resolve("observed_completed")}
          >
            {t(locale, "cuaRecovery.completed")}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={resolvingDisabled}
            data-testid="cua-recovery-not-applied"
            onClick={() => resolve("observed_not_applied")}
          >
            {t(locale, "cuaRecovery.notApplied")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={resolvingDisabled}
            data-testid="cua-recovery-accept-unknown"
            onClick={() => resolve("accept_unknown")}
          >
            {t(locale, "cuaRecovery.acceptUnknown")}
          </Button>
        </div>
        <AlertDialogFooter className="sm:justify-start">
          <AlertDialogCancel
            disabled={busy}
            data-testid="cua-recovery-leave-blocked"
            onClick={() => {
              settledRef.current = true;
              props.onLeaveBlocked();
            }}
          >
            {busy ? t(locale, "cuaRecovery.saving") : t(locale, "cuaRecovery.leaveBlocked")}
          </AlertDialogCancel>
        </AlertDialogFooter>
        {props.error ? (
          <p className="m-0 text-sm text-destructive" role="alert">
            {props.error}
          </p>
        ) : null}
      </AlertDialogContent>
    </AlertDialog>
  );
}
