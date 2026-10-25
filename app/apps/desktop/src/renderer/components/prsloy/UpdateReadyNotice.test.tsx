// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { AppUpdateStatus } from "@zeno/contracts";
import { UpdateReadyNotice } from "./UpdateReadyNotice.tsx";

afterEach(cleanup);

function mockApp(initial: AppUpdateStatus) {
  let listener: ((status: AppUpdateStatus) => void) | undefined;
  const app = {
    getUpdateStatus: vi.fn().mockResolvedValue(initial),
    onUpdateStatus: vi.fn((fn: (status: AppUpdateStatus) => void) => {
      listener = fn;
      return () => undefined;
    }),
    quitAndInstall: vi.fn().mockResolvedValue(undefined),
  };
  (window as unknown as { zeno: unknown }).zeno = { app };
  return { app, push: (status: AppUpdateStatus) => act(() => listener?.(status)) };
}

const base = { currentVersion: "0.1.0-alpha.2", canCheck: true } as const;

describe("UpdateReadyNotice", () => {
  it("stays silent until the update is downloaded, then restarts on click", async () => {
    const { app, push } = mockApp({ ...base, state: "checking" });
    render(<UpdateReadyNotice />);
    await act(async () => undefined);
    expect(screen.queryByTestId("prsloy-update-ready")).toBeNull();
    push({ ...base, state: "error", error: "No published versions" });
    expect(screen.queryByTestId("prsloy-update-ready")).toBeNull();
    push({ ...base, state: "downloaded", availableVersion: "0.1.0-alpha.3" });
    const notice = await screen.findByTestId("prsloy-update-ready");
    fireEvent.click(notice.querySelector("button")!);
    expect(app.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("hides for the session when dismissed", async () => {
    mockApp({ ...base, state: "downloaded", availableVersion: "0.1.0-alpha.3" });
    render(<UpdateReadyNotice />);
    const notice = await screen.findByTestId("prsloy-update-ready");
    fireEvent.click(notice.querySelectorAll("button")[1]!);
    expect(screen.queryByTestId("prsloy-update-ready")).toBeNull();
  });
});
