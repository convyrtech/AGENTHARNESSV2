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
import type { Locale } from "../lib/i18n.ts";

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
  if (hasCua && !hasMunim)
    return locale === "ru" ? `Проверить действие Cua (${count})` : `Review Cua action (${count})`;
  if (hasMunim && !hasCua)
    return locale === "ru"
      ? `Проверить действие Munim (${count})`
      : `Review Munim action (${count})`;
  return locale === "ru"
    ? `Проверить действия Cua и Munim (${count})`
    : `Review Cua and Munim actions (${count})`;
}

function formatTime(createdAt: number, locale: Locale): string {
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime())) return locale === "ru" ? "неизвестно" : "unknown";
  return new Intl.DateTimeFormat(locale === "ru" ? "ru-RU" : "en-US", {
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
  const ru = props.locale === "ru";
  const busy = props.busy === true;
  const backendName = props.pending.backend === "munim" ? "Munim" : "Cua";
  // A dispatch still owned by a live host cannot be resolved as a lost result.
  const resolvingDisabled = busy || props.pending.status === "dispatching" || !acknowledged;
  const actionName =
    props.pending.kind === "click"
      ? ru
        ? "нажатие"
        : "click"
      : props.pending.kind === "type_text"
        ? ru
          ? "ввод текста"
          : "text entry"
        : ru
          ? "действие"
          : "action";
  const targetDescription =
    props.pending.backend === "munim"
      ? ru
        ? `Проверь Munim, PID ${props.pending.pid}: ${actionName}, начато ${formatTime(props.pending.createdAt, props.locale)}.`
        : `Check Munim, PID ${props.pending.pid}: ${actionName}, started ${formatTime(props.pending.createdAt, props.locale)}.`
      : ru
        ? `Проверь окно PID ${props.pending.pid}, HWND ${props.pending.windowId}: ${actionName}, начато ${formatTime(props.pending.createdAt, props.locale)}.`
        : `Check window PID ${props.pending.pid}, HWND ${props.pending.windowId}: ${actionName}, started ${formatTime(props.pending.createdAt, props.locale)}.`;

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
            {ru ? "Проверь результат действия" : "Check the action result"}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-[13px] leading-relaxed text-muted-foreground">
              <p className="m-0">
                {ru
                  ? `PRSLOY потерял подтверждённый ответ от ${backendName}. Действие могло ещё не начаться, уже сработать или продолжать выполняться. Остановка модели не отменяет его в другом приложении.`
                  : `PRSLOY lost ${backendName}’s result. The action may not have started yet, may have completed, or may still be running. Stopping the model does not cancel it in another app.`}
              </p>
              <p className="m-0">{targetDescription}</p>
              <p
                className="m-0 rounded-md bg-muted/60 px-2 py-1.5 font-mono text-[11px] break-all"
                data-testid="cua-recovery-action-id"
              >
                {props.pending.actionId}
              </p>
              <p className="m-0 font-medium text-foreground">
                {ru
                  ? "Пока не проверишь состояние приложения, оставь блокировку. При подтверждении неизвестного результата повтор автоматически не запускается."
                  : "Leave the gate closed until you inspect the app. Resolving an unknown result never retries the action automatically."}
              </p>
              {props.pending.status === "dispatching" ? (
                <p className="m-0 font-medium text-foreground">
                  {ru
                    ? `Запись о действии сохранена, но вызов ${backendName} мог ещё не начаться. Он может стартовать позже или всё ещё выполняться, даже после освобождения блокировки.`
                    : `The action intent is recorded, but the ${backendName} call may not have started yet. It could start later or still be running after the gate is released.`}
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
              <span>
                {ru
                  ? "Я принимаю риск, что действие ещё запустится или завершится позже и может выполняться одновременно со следующим."
                  : "I accept that this action may start or finish later and may run at the same time as the next one."}
              </span>
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
              {ru ? "Принять риск и снять блокировку" : "Accept risk and release gate"}
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
          <span>
            {ru
              ? "Я понимаю, что действие может завершиться позже, даже если сейчас его результат не виден, и принимаю этот риск."
              : "I understand that the action may finish later even if no result is visible now, and accept this risk."}
          </span>
        </label>
        <div className="grid gap-2">
          <Button
            type="button"
            variant="default"
            disabled={resolvingDisabled}
            data-testid="cua-recovery-completed"
            onClick={() => resolve("observed_completed")}
          >
            {ru ? "Проверил: действие выполнено" : "I checked: action completed"}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={resolvingDisabled}
            data-testid="cua-recovery-not-applied"
            onClick={() => resolve("observed_not_applied")}
          >
            {ru ? "Проверил: действие не выполнено" : "I checked: action did not happen"}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={resolvingDisabled}
            data-testid="cua-recovery-accept-unknown"
            onClick={() => resolve("accept_unknown")}
          >
            {ru ? "Продолжить, принимая неизвестный результат" : "Continue despite unknown result"}
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
            {busy ? (ru ? "Сохранение…" : "Saving…") : ru ? "Оставить блокировку" : "Leave blocked"}
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
