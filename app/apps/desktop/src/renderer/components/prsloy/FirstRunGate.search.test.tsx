// @vitest-environment jsdom
/**
 * #23 with FIRST_RUN_SEARCH_STEP on (off for alpha.2): the first run asks about web search between the import and the folder.
 * (FirstRunGate.test.tsx covers the default, where the step is not shown.)
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { PrsloyState } from "@zeno/contracts";
import { FirstRunGate } from "./FirstRunGate.tsx";

vi.mock("../../../shared/search-ready.ts", () => ({
  SEARCH_READY: true,
  FIRST_RUN_SEARCH_STEP: true,
}));

afterEach(cleanup);

const withKey: PrsloyState = {
  hasKey: true,
  keyMemoryOnly: false,
  maskedKey: "sk-…good",
  baseUrl: "https://api.prsloy.online/v1",
  defaultBaseUrl: "https://api.prsloy.online/v1",
  needsWorkspace: true,
  harnessLoaded: false,
  firstRunBypass: false,
  gitSetup: { status: "absent" },
};

describe("FirstRunGate with SEARCH_READY", () => {
  it("asks about search after the import; «Включить поиск» turns webTools on and goes to the folder", async () => {
    localStorage.clear();
    const flags = { get: vi.fn(), set: vi.fn().mockResolvedValue({ webTools: true }) };
    (window as unknown as { zeno: unknown }).zeno = {
      prsloy: { getState: vi.fn().mockResolvedValue(withKey), setKey: vi.fn() },
      workspace: {
        pickFolder: vi.fn(),
        openPath: vi.fn(),
        listRecent: vi.fn().mockResolvedValue([]),
        openExternal: vi.fn(),
      },
      harnessFlags: flags,
    };
    render(
      <FirstRunGate>
        <div>APP</div>
      </FirstRunGate>,
    );
    expect((await screen.findByTestId("prsloy-first-run-search")).textContent).toContain(
      "Разрешить агенту искать в интернете?",
    );
    fireEvent.click(screen.getByTestId("first-run-search-on"));
    await screen.findByTestId("prsloy-first-run-folder");
    expect(flags.set).toHaveBeenCalledWith({ webTools: true });
    expect(localStorage.getItem("prsloy.firstRun.searchSeen")).toBe("1");
  });
});
