// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { PrsloyState } from "@zeno/contracts";
import { FirstRunGate } from "./FirstRunGate.tsx";

afterEach(cleanup);

const fresh: PrsloyState = {
  hasKey: false,
  keyMemoryOnly: false,
  maskedKey: "",
  baseUrl: "https://api.prsloy.online/v1",
  defaultBaseUrl: "https://api.prsloy.online/v1",
  needsWorkspace: true,
  harnessLoaded: false,
  firstRunBypass: false,
};

function mockZeno(overrides: Record<string, unknown> = {}) {
  const api = {
    prsloy: {
      getState: vi.fn().mockResolvedValue(fresh),
      setKey: vi.fn(),
      ...overrides,
    },
    workspace: {
      pickFolder: vi.fn().mockResolvedValue("/home/u/site"),
      openPath: vi.fn().mockResolvedValue({}),
    },
  };
  (window as unknown as { zeno: unknown }).zeno = api;
  return api;
}

describe("FirstRunGate", () => {
  it("walks key → folder → app and shows a human error for a bad key", async () => {
    const api = mockZeno();
    api.prsloy.setKey
      .mockResolvedValueOnce({ ok: false, code: "invalid_key", status: 401 })
      .mockResolvedValueOnce({ ok: true, modelIds: [], state: { ...fresh, hasKey: true } });
    render(
      <FirstRunGate>
        <div>APP</div>
      </FirstRunGate>,
    );
    await screen.findByTestId("prsloy-first-run-key");
    const input = screen.getByPlaceholderText("sk-…");

    fireEvent.change(input, { target: { value: " sk-wrong\n" } });
    fireEvent.submit(input.closest("form")!);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(api.prsloy.setKey).toHaveBeenLastCalledWith("sk-wrong");

    fireEvent.change(input, { target: { value: "sk-good" } });
    fireEvent.submit(input.closest("form")!);
    await screen.findByTestId("prsloy-first-run-folder");
    expect(screen.queryByText("APP")).toBeNull();

    api.prsloy.getState.mockResolvedValue({ ...fresh, hasKey: true, needsWorkspace: false });
    fireEvent.click(screen.getByRole("button"));
    await screen.findByText("APP");
    expect(api.workspace.openPath).toHaveBeenCalledWith("/home/u/site");
  });

  it("renders the app directly when set up or bypassed, and when IPC is missing", async () => {
    mockZeno({ getState: vi.fn().mockResolvedValue({ ...fresh, firstRunBypass: true }) });
    render(
      <FirstRunGate>
        <div>APP</div>
      </FirstRunGate>,
    );
    await screen.findByText("APP");
    cleanup();
    mockZeno({ getState: vi.fn().mockRejectedValue(new Error("no handler")) });
    render(
      <FirstRunGate>
        <div>APP2</div>
      </FirstRunGate>,
    );
    await waitFor(() => expect(screen.getByText("APP2")).toBeTruthy());
  });
});
