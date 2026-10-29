// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { AppUpdateStatus } from "@zeno/contracts";
import { t, type MessageKey } from "../lib/i18n.ts";
import { SidebarUpdateButton } from "./AppSidebar.tsx";

const tr = (key: MessageKey, vars?: Record<string, string>) => t("ru", key, vars);

function mockUpdateStatus(status: AppUpdateStatus) {
  const getUpdateStatus = vi.fn().mockResolvedValue(status);
  vi.stubGlobal("zeno", {
    app: {
      getUpdateStatus,
      onUpdateStatus: vi.fn(() => () => undefined),
      checkForUpdates: vi.fn(),
      downloadUpdate: vi.fn(),
      quitAndInstall: vi.fn(),
    },
  });
  return { getUpdateStatus };
}

beforeEach(() => {
  localStorage.clear();
  // The bug hid GitHub only in casual mode. Idle must be empty in developer mode too.
  localStorage.setItem("prsloy.casual.prefs.v1", JSON.stringify({ developerMode: true }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("sidebar update button (#51)", () => {
  it("renders no button and no GitHub link when there is no update", async () => {
    const { getUpdateStatus } = mockUpdateStatus({
      state: "idle",
      currentVersion: "0.1.0",
      canCheck: true,
    });
    const { container } = render(<SidebarUpdateButton locale="ru" tr={tr} />);
    await waitFor(() => expect(getUpdateStatus).toHaveBeenCalled());
    expect(screen.queryByTestId("sidebar-update-btn")).toBeNull();
    expect(container.querySelector("a,button,svg")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("keeps the download button when an update is available", async () => {
    mockUpdateStatus({
      state: "available",
      currentVersion: "0.1.0",
      availableVersion: "0.2.0",
      canCheck: true,
    });
    render(<SidebarUpdateButton locale="ru" tr={tr} />);
    const button = await screen.findByTestId("sidebar-update-btn");
    expect(button.getAttribute("data-phase")).toBe("available");
    expect(button.getAttribute("aria-label")).toBe(tr("nav.update.available"));
  });
});
