// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { FirstRunSearch } from "./FirstRunSearch.tsx";

const flags = { get: vi.fn(), set: vi.fn() };

beforeEach(() => {
  flags.set.mockReset().mockResolvedValue({ webTools: true });
  (window as unknown as { zeno: unknown }).zeno = { harnessFlags: flags };
});
afterEach(cleanup);

describe("first run: «Разрешить агенту искать в интернете?»", () => {
  it("«Включить поиск» turns webTools on, then goes on", async () => {
    const onDone = vi.fn();
    render(<FirstRunSearch locale="ru" onDone={onDone} />);
    expect(screen.getByTestId("first-run-search").textContent).toContain("ключ не нужен");
    fireEvent.click(screen.getByTestId("first-run-search-on"));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(flags.set).toHaveBeenCalledWith({ webTools: true });
  });

  it("«Не сейчас» writes it off (the default may be on), then goes on", async () => {
    const onDone = vi.fn();
    render(<FirstRunSearch locale="ru" onDone={onDone} />);
    fireEvent.click(screen.getByTestId("first-run-search-skip"));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(flags.set).toHaveBeenCalledWith({ webTools: false });
  });

  it("a failed switch is shown and the step stays", async () => {
    flags.set.mockRejectedValue(new Error("нет связи"));
    const onDone = vi.fn();
    render(<FirstRunSearch locale="ru" onDone={onDone} />);
    fireEvent.click(screen.getByTestId("first-run-search-on"));
    expect((await screen.findByRole("alert")).textContent).toContain("нет связи");
    expect(onDone).not.toHaveBeenCalled();
  });
});
