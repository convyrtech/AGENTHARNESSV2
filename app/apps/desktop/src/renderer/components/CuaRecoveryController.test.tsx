// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { CuaRecoveryItem } from "@zeno/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { CuaRecoveryController } from "./CuaRecoveryController.tsx";

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "zeno");
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const item: CuaRecoveryItem = {
  actionId: "action-1",
  challenge: "challenge-1",
  pid: 1234,
  windowId: 5678,
  kind: "click",
  status: "unknown",
  createdAt: Date.UTC(2026, 10, 2, 12),
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function installApi(list: () => Promise<CuaRecoveryItem[]>, resolve = vi.fn()) {
  Object.defineProperty(window, "zeno", {
    configurable: true,
    value: {
      prsloy: {
        cuaRecovery: {
          list,
          resolve,
          acceptInFlightRisk: vi.fn(),
        },
      },
    },
  });
  return resolve;
}

async function openAndResolve() {
  await act(async () => {
    fireEvent.click(screen.getByTestId("cua-recovery-open"));
  });
  fireEvent.click(screen.getByTestId("cua-recovery-acknowledge"));
  fireEvent.click(screen.getByTestId("cua-recovery-not-applied"));
}

describe("CuaRecoveryController request ordering", () => {
  it("does not overlap background polls while a list request is pending", async () => {
    vi.useFakeTimers();
    const pendingList = deferred<CuaRecoveryItem[]>();
    const list = vi.fn().mockReturnValue(pendingList.promise);
    installApi(list);
    render(<CuaRecoveryController locale="en" />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
    });
    expect(list).toHaveBeenCalledTimes(1);

    await act(async () => {
      pendingList.resolve([item]);
      await pendingList.promise;
    });
    expect(screen.getByTestId("cua-recovery-open")).toBeInTheDocument();
  });

  it("times out hung lists, caps outstanding IPC calls, and ignores late results", async () => {
    vi.useFakeTimers();
    const first = deferred<CuaRecoveryItem[]>();
    const second = deferred<CuaRecoveryItem[]>();
    const list = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockResolvedValueOnce([item]);
    installApi(list);
    render(<CuaRecoveryController locale="en" />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Timed out waiting");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(list).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });
    expect(list).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("alert")).toHaveTextContent("Too many unfinished");

    await act(async () => {
      first.resolve([]);
      await first.promise;
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(list).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId("cua-recovery-open")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await act(async () => {
      second.resolve([]);
      await second.promise;
    });
    expect(screen.getByTestId("cua-recovery-open")).toBeInTheDocument();
  });

  it("retries after a forced refresh hits the cap and a timed-out IPC later settles", async () => {
    vi.useFakeTimers();
    const firstHang = deferred<CuaRecoveryItem[]>();
    const secondHang = deferred<CuaRecoveryItem[]>();
    const resolveAction = vi.fn().mockResolvedValue(undefined);
    const list = vi
      .fn()
      .mockResolvedValueOnce([item])
      .mockReturnValueOnce(firstHang.promise)
      .mockReturnValueOnce(secondHang.promise)
      .mockResolvedValueOnce([]);
    installApi(list, resolveAction);
    render(<CuaRecoveryController locale="en" />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("cua-recovery-open")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(list).toHaveBeenCalledTimes(3);

    await act(async () => {
      await openAndResolve();
    });
    expect(resolveAction).toHaveBeenCalledExactlyOnceWith(
      item.actionId,
      item.challenge,
      "observed_not_applied",
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Too many unfinished");
    expect(list).toHaveBeenCalledTimes(3);

    await act(async () => {
      firstHang.resolve([]);
      await firstHang.promise;
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(list).toHaveBeenCalledTimes(4);
    expect(screen.queryByTestId("cua-recovery-open")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await act(async () => {
      secondHang.resolve([item]);
      await secondHang.promise;
    });
    expect(screen.queryByTestId("cua-recovery-open")).not.toBeInTheDocument();
  });

  it("ignores a stale list error after a successful owner resolution", async () => {
    const stale = deferred<CuaRecoveryItem[]>();
    const resolveAction = vi.fn().mockResolvedValue(undefined);
    const list = vi
      .fn()
      .mockResolvedValueOnce([item])
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce([]);
    installApi(list, resolveAction);
    vi.useFakeTimers();
    render(<CuaRecoveryController locale="en" />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("cua-recovery-open")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(list).toHaveBeenCalledTimes(2);

    await act(async () => {
      await openAndResolve();
    });
    expect(resolveAction).toHaveBeenCalledExactlyOnceWith(
      item.actionId,
      item.challenge,
      "observed_not_applied",
    );
    expect(list).toHaveBeenCalledTimes(3);
    expect(screen.queryByTestId("cua-recovery-open")).not.toBeInTheDocument();

    await act(async () => {
      stale.reject(new Error("stale list failure"));
      await stale.promise.catch(() => undefined);
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByTestId("cua-recovery-open")).not.toBeInTheDocument();
  });

  it("keeps an owner decision error visible when a background poll succeeds", async () => {
    const pendingPoll = deferred<CuaRecoveryItem[]>();
    const resolveAction = vi.fn().mockRejectedValue(new Error("owner decision failed"));
    const list = vi.fn().mockResolvedValueOnce([item]).mockReturnValueOnce(pendingPoll.promise);
    installApi(list, resolveAction);
    vi.useFakeTimers();
    render(<CuaRecoveryController locale="en" />);
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    await act(async () => {
      await openAndResolve();
    });
    expect(screen.getByRole("alert")).toHaveTextContent("owner decision failed");

    await act(async () => {
      pendingPoll.resolve([]);
      await pendingPoll.promise;
    });
    expect(screen.getByRole("alert")).toHaveTextContent("owner decision failed");
  });

  it("invalidates a delayed list when unmounted and stops polling", async () => {
    vi.useFakeTimers();
    const pendingList = deferred<CuaRecoveryItem[]>();
    const list = vi.fn().mockReturnValue(pendingList.promise);
    installApi(list);
    const { unmount } = render(<CuaRecoveryController locale="en" />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
    });
    expect(list).toHaveBeenCalledTimes(1);
    unmount();

    await act(async () => {
      pendingList.resolve([item]);
      await pendingList.promise;
      await vi.advanceTimersByTimeAsync(9_000);
    });
    expect(list).toHaveBeenCalledTimes(1);
  });
});
