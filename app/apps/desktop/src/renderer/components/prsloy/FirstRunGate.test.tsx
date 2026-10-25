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
  gitSetup: { status: "absent" },
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
      listRecent: vi.fn().mockResolvedValue([]),
      openExternal: vi.fn().mockResolvedValue(undefined),
    },
  };
  (window as unknown as { zeno: unknown }).zeno = api;
  return api;
}

describe("FirstRunGate", () => {
  it("walks key → (import, search) → folder → app and shows a human error for a bad key", async () => {
    localStorage.clear();
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
    // import passed by itself on the way and is remembered; no search step (FIRST_RUN_SEARCH_STEP off)
    expect(localStorage.getItem("prsloy.firstRun.importSeen")).toBe("1");
    expect(screen.queryByTestId("first-run-search")).toBeNull();

    api.prsloy.getState.mockResolvedValue({ ...fresh, hasKey: true, needsWorkspace: false });
    fireEvent.click(screen.getByTestId("prsloy-folder-pick"));
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

  it("links to where keys are sold and offers recent folders", async () => {
    const api = mockZeno();
    render(
      <FirstRunGate>
        <div>APP</div>
      </FirstRunGate>,
    );
    fireEvent.click(await screen.findByTestId("prsloy-key-link"));
    expect(api.workspace.openExternal).toHaveBeenCalledWith("https://prsloy.online");
    cleanup();

    const withKey = mockZeno({
      getState: vi.fn().mockResolvedValue({ ...fresh, hasKey: true }),
    });
    withKey.workspace.listRecent.mockResolvedValue(["/home/u/zerno", "C:\\Users\\u\\shop"]);
    render(
      <FirstRunGate>
        <div>APP</div>
      </FirstRunGate>,
    );
    await screen.findByTestId("prsloy-folder-recent");
    expect(screen.getByText("shop")).toBeTruthy();
    fireEvent.click(screen.getByText("zerno"));
    await waitFor(() => expect(withKey.workspace.openPath).toHaveBeenCalledWith("/home/u/zerno"));
  });

  it("accepts a folder under tmp and explains a refused scratch folder in words", async () => {
    const api = mockZeno({
      getState: vi.fn().mockResolvedValue({ ...fresh, hasKey: true }),
    });
    api.workspace.pickFolder
      .mockResolvedValueOnce("C:/Users/u/Documents/PRSLOY/2026-10-25")
      .mockResolvedValueOnce("D:\\tmp\\сайт");
    render(
      <FirstRunGate>
        <div>APP</div>
      </FirstRunGate>,
    );
    fireEvent.click(await screen.findByTestId("prsloy-folder-pick"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/служебная|scratch|临时/u);
    expect(api.workspace.openPath).not.toHaveBeenCalled();

    api.prsloy.getState.mockResolvedValue({ ...fresh, hasKey: true, needsWorkspace: false });
    fireEvent.click(screen.getByTestId("prsloy-folder-pick"));
    await screen.findByText("APP");
    expect(api.workspace.openPath).toHaveBeenCalledWith("D:\\tmp\\сайт");
  });

  it("checks the key against another server when one is given", async () => {
    const api = mockZeno();
    api.prsloy.setKey.mockResolvedValue({ ok: false, code: "bad_url" });
    render(
      <FirstRunGate>
        <div>APP</div>
      </FirstRunGate>,
    );
    await screen.findByTestId("prsloy-first-run-key");
    fireEvent.click(screen.getByTestId("prsloy-server-link"));
    const server = screen.getByTestId("prsloy-server-input") as HTMLInputElement;
    expect(server.value).toBe("https://api.prsloy.online/v1");
    fireEvent.change(server, { target: { value: " https://gw.example/v1 " } });
    const key = screen.getByPlaceholderText("sk-…");
    fireEvent.change(key, { target: { value: "sk-1" } });
    fireEvent.submit(key.closest("form")!);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(api.prsloy.setKey).toHaveBeenLastCalledWith("sk-1", "https://gw.example/v1");
  });
});
