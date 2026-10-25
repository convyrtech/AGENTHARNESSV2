// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useForgetChatMemory } from "./ForgetChatMemory.tsx";

function Harness(props: { sessionId: string | undefined }) {
  const forget = useForgetChatMemory({ locale: "ru", sessionId: props.sessionId });
  return (
    <>
      {forget.menuItem(() => undefined)}
      {forget.dialogs}
    </>
  );
}

const before = {
  user: [
    { id: "a", text: "Отвечать коротко" },
    { id: "b", text: "Звать меня Ваня" },
  ],
  project: [],
};
const api = { list: vi.fn(), forgetSource: vi.fn(), restore: vi.fn() };

beforeEach(() => {
  api.list.mockReset().mockResolvedValue(before);
  api.forgetSource.mockReset().mockResolvedValue({ user: [before.user[1]!], project: [] });
  api.restore.mockReset().mockResolvedValue(before);
  (window as unknown as { zeno: unknown }).zeno = { memory: api };
});
afterEach(cleanup);

describe("chat ⋯ → «Забыть всё, что выучено из этого чата»", () => {
  it("asks, forgets by the Pi session id, lists what went, «Вернуть» restores it", async () => {
    render(<Harness sessionId="0198-pi-session" />);
    fireEvent.click(screen.getByTestId("thread-header-forget-memory"));
    const ask = await screen.findByTestId("forget-chat-memory-confirm");
    expect(ask.textContent).toContain("их можно будет вернуть");
    fireEvent.click(within(ask).getByText("Забыть"));
    await waitFor(() =>
      expect(api.forgetSource).toHaveBeenCalledWith("0198-pi-session", undefined),
    );
    const result = await screen.findByTestId("forget-chat-memory-result");
    expect(result.textContent).toContain("Забыл записей: 1");
    expect(result.textContent).toContain("«Отвечать коротко»");
    fireEvent.click(within(result).getByText("Вернуть"));
    await waitFor(() => expect(api.restore).toHaveBeenCalledWith("a", undefined));
  });

  it("is not offered without a session id or without forgetSource in main", () => {
    render(<Harness sessionId={undefined} />);
    expect(screen.queryByTestId("thread-header-forget-memory")).toBeNull();
    cleanup();
    (window as unknown as { zeno: unknown }).zeno = { memory: { list: vi.fn() } };
    render(<Harness sessionId="s" />);
    expect(screen.queryByTestId("thread-header-forget-memory")).toBeNull();
  });
});
