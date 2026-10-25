// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ToolsSetupNotice } from "./ToolsSetupNotice.tsx";

afterEach(cleanup);

function mockState(states: unknown[]) {
  const getState = vi.fn();
  for (const s of states) getState.mockResolvedValueOnce(s);
  getState.mockResolvedValue(states.at(-1));
  (window as unknown as { zeno: unknown }).zeno = { prsloy: { getState } };
  return getState;
}

const installing = (percent: number) => ({ appSetup: { status: "installing", percent } });

describe("ToolsSetupNotice", () => {
  it("shows progress while the tools unpack, then disappears and stops asking", async () => {
    const getState = mockState([installing(40), installing(80), { appSetup: { status: "ready" } }]);
    render(<ToolsSetupNotice pollMs={5} />);
    expect(await screen.findByTestId("prsloy-turn-setup")).toHaveProperty(
      "textContent",
      expect.stringMatching(/(40|80)%/),
    );
    await act(async () => new Promise((r) => setTimeout(r, 40)));
    expect(screen.queryByTestId("prsloy-turn-setup")).toBeNull();
    const calls = getState.mock.calls.length;
    await act(async () => new Promise((r) => setTimeout(r, 40)));
    expect(getState.mock.calls.length).toBe(calls);
  });

  it("stays silent when nothing unpacks (every launch after the first)", async () => {
    mockState([{ appSetup: { status: "ready" }, gitSetup: { status: "ready" } }]);
    render(<ToolsSetupNotice pollMs={5} />);
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(screen.queryByTestId("prsloy-turn-setup")).toBeNull();
  });
});
