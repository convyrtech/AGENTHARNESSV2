// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  CuaRecoveryDialog,
  type CuaRecoveryPendingAction,
  type CuaRecoveryResolution,
  cuaRecoveryBannerLabel,
} from "./CuaRecoveryDialog.tsx";

afterEach(cleanup);

const pending = {
  actionId: "<img src=x onerror=alert(1)>",
  challenge: "challenge-nonce",
  pid: 1234,
  windowId: 5678,
  kind: "click" as const,
  status: "unknown" as const,
  createdAt: Date.UTC(2026, 10, 2, 12),
};

function renderDialog(
  onResolve = vi.fn(),
  onLeaveBlocked = vi.fn(),
  onAcceptInFlightRisk = vi.fn(),
  action: CuaRecoveryPendingAction = pending,
  locale: "ru" | "en" | "zh" = "ru",
) {
  render(
    <CuaRecoveryDialog
      open
      pending={action}
      locale={locale}
      onResolve={onResolve}
      onAcceptInFlightRisk={onAcceptInFlightRisk}
      onLeaveBlocked={onLeaveBlocked}
    />,
  );
  return { onResolve, onLeaveBlocked };
}

describe("CuaRecoveryDialog", () => {
  it("keeps the legacy Cua target label with HWND", () => {
    renderDialog();
    expect(screen.getByTestId("cua-recovery-dialog")).toHaveTextContent(
      /Проверь окно PID 1234, HWND 5678/u,
    );
  });

  it("labels Munim and PID without rendering null as an HWND", () => {
    renderDialog(vi.fn(), vi.fn(), vi.fn(), { ...pending, backend: "munim", windowId: null });
    expect(screen.getByTestId("cua-recovery-dialog")).toHaveTextContent(/Проверь Munim, PID 1234/u);
    expect(screen.getByTestId("cua-recovery-dialog")).not.toHaveTextContent(/HWND/u);
    expect(screen.getByTestId("cua-recovery-dialog")).not.toHaveTextContent(/null/u);
  });

  it("uses the selected backend in recovery copy and retains the Cua wording", () => {
    renderDialog(vi.fn(), vi.fn(), vi.fn(), { ...pending, backend: "munim", windowId: null });
    const dialog = screen.getByTestId("cua-recovery-dialog");
    expect(dialog).toHaveTextContent(/потерял подтверждённый ответ от Munim/u);
    expect(dialog).not.toHaveTextContent(/ответ от Cua|вызов Cua/u);

    cleanup();
    renderDialog();
    expect(screen.getByTestId("cua-recovery-dialog")).toHaveTextContent(
      /потерял подтверждённый ответ от Cua/u,
    );
  });

  it("names Munim in the in-flight recovery warning", () => {
    renderDialog(vi.fn(), vi.fn(), vi.fn(), {
      ...pending,
      backend: "munim",
      windowId: null,
      status: "dispatching",
    });
    expect(screen.getByTestId("cua-recovery-dialog")).toHaveTextContent(
      /вызов Munim мог ещё не начаться/u,
    );
    expect(screen.getByTestId("cua-recovery-dialog")).not.toHaveTextContent(/вызов Cua/u);
  });

  it("labels the recovery banner for Cua, Munim, and mixed backends", () => {
    expect(cuaRecoveryBannerLabel([{}], "ru")).toBe("Проверить действие Cua (1)");
    expect(cuaRecoveryBannerLabel([{ backend: "munim" }], "ru")).toBe(
      "Проверить действие Munim (1)",
    );
    expect(cuaRecoveryBannerLabel([{}, { backend: "munim" }], "en")).toBe(
      "Review Cua and Munim actions (2)",
    );
    expect(cuaRecoveryBannerLabel([{}], "zh")).toBe("检查 Cua 操作（1）");
  });

  it("renders the recovery dialog in Chinese instead of falling back to English", () => {
    renderDialog(vi.fn(), vi.fn(), vi.fn(), pending, "zh");
    const dialog = screen.getByTestId("cua-recovery-dialog");
    expect(dialog).toHaveTextContent("检查操作结果");
    expect(dialog).toHaveTextContent("PRSLOY 未收到来自 Cua 的已确认回复");
    expect(dialog).toHaveTextContent("保持操作门关闭");
    expect(dialog).toHaveTextContent("接受结果未知并继续");
    expect(dialog).not.toHaveTextContent("Check the action result");
  });

  it("explains that stopping does not cancel the external action and renders IDs as text", () => {
    renderDialog();
    expect(screen.getByText(/могло ещё не начаться/u)).toBeInTheDocument();
    expect(screen.getByTestId("cua-recovery-action-id")).toHaveTextContent(pending.actionId);
    expect(document.querySelector("img")).not.toBeInTheDocument();
  });

  it("does not resolve automatically and leaves the gate blocked on dismiss", () => {
    const { onResolve, onLeaveBlocked } = renderDialog();
    expect(onResolve).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("cua-recovery-leave-blocked"));
    expect(onLeaveBlocked).toHaveBeenCalledTimes(1);
    expect(onResolve).not.toHaveBeenCalled();
  });

  it.each([
    ["cua-recovery-completed", "observed_completed"],
    ["cua-recovery-not-applied", "observed_not_applied"],
    ["cua-recovery-accept-unknown", "accept_unknown"],
  ] as const)("sends an explicit %s decision with the exact action ID", (button, resolution) => {
    const onResolve =
      vi.fn<(resolution: CuaRecoveryResolution, actionId: string, challenge: string) => void>();
    renderDialog(onResolve);
    expect(screen.getByTestId(button)).toBeDisabled();
    fireEvent.click(screen.getByTestId("cua-recovery-acknowledge"));
    fireEvent.click(screen.getByTestId(button));
    expect(onResolve).toHaveBeenCalledExactlyOnceWith(
      resolution,
      pending.actionId,
      pending.challenge,
    );
  });

  it("prevents owner decisions while a resolution request is busy", () => {
    const onResolve = vi.fn();
    render(
      <CuaRecoveryDialog
        open
        busy
        pending={pending}
        locale="ru"
        onResolve={onResolve}
        onAcceptInFlightRisk={() => {}}
        onLeaveBlocked={() => {}}
      />,
    );
    for (const button of [
      "cua-recovery-completed",
      "cua-recovery-not-applied",
      "cua-recovery-accept-unknown",
      "cua-recovery-leave-blocked",
    ]) {
      expect(screen.getByTestId(button)).toBeDisabled();
    }
    expect(onResolve).not.toHaveBeenCalled();
  });

  it("does not offer resolution while the action is still dispatching", () => {
    const onResolve = vi.fn();
    render(
      <CuaRecoveryDialog
        open
        pending={{ ...pending, status: "dispatching" }}
        locale="ru"
        onResolve={onResolve}
        onAcceptInFlightRisk={() => {}}
        onLeaveBlocked={() => {}}
      />,
    );
    for (const button of [
      "cua-recovery-completed",
      "cua-recovery-not-applied",
      "cua-recovery-accept-unknown",
    ]) {
      expect(screen.getByTestId(button)).toBeDisabled();
    }
    expect(onResolve).not.toHaveBeenCalled();
  });

  it("requires explicit acceptance of a delayed start and overlap before releasing the gate", () => {
    const onAccept = vi.fn();
    render(
      <CuaRecoveryDialog
        open
        pending={{ ...pending, status: "dispatching" }}
        locale="ru"
        onResolve={() => {}}
        onAcceptInFlightRisk={onAccept}
        onLeaveBlocked={() => {}}
      />,
    );
    expect(screen.getByTestId("cua-recovery-dialog")).toHaveTextContent(
      /вызов Cua мог ещё не начаться/u,
    );
    expect(
      screen.getByTestId("cua-recovery-acknowledge-in-flight").parentElement,
    ).toHaveTextContent(/ещё запустится или завершится позже.*одновременно со следующим/u);
    expect(screen.getByTestId("cua-recovery-accept-in-flight")).toBeDisabled();
    fireEvent.click(screen.getByTestId("cua-recovery-acknowledge-in-flight"));
    fireEvent.click(screen.getByTestId("cua-recovery-accept-in-flight"));
    expect(onAccept).toHaveBeenCalledExactlyOnceWith(pending.actionId, pending.challenge);
  });
});
