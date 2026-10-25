// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { HostEvent } from "@zeno/contracts";
import { HOST_RECOVERY_NOTICE_MS, HostRecoveryNotice } from "./HostRecoveryNotice.tsx";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function mockHost() {
  let listener: ((event: HostEvent) => void) | undefined;
  (window as unknown as { zeno: unknown }).zeno = {
    host: {
      onEvent: (fn: (event: HostEvent) => void) => {
        listener = fn;
        return () => undefined;
      },
    },
  };
  return (event: Record<string, unknown>) => act(() => listener?.(event as unknown as HostEvent));
}

describe("HostRecoveryNotice", () => {
  it("speaks once after crash → restart, then hides; ignores ordinary restarts", () => {
    vi.useFakeTimers();
    const emit = mockHost();
    render(<HostRecoveryNotice />);
    emit({ type: "host.restarted" });
    expect(screen.queryByTestId("prsloy-host-recovered")).toBeNull();
    emit({ type: "host.crashed", exitCode: 1, message: "boom" });
    expect(screen.queryByTestId("prsloy-host-recovered")).toBeNull();
    emit({ type: "host.restarted" });
    expect(screen.getByTestId("prsloy-host-recovered").textContent).toMatch(
      /перезапущен|restarted|重启/u,
    );
    act(() => {
      vi.advanceTimersByTime(HOST_RECOVERY_NOTICE_MS + 10);
    });
    expect(screen.queryByTestId("prsloy-host-recovered")).toBeNull();
  });
});
