// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { loadUndoOutcome } from "../lib/undo-log.ts";
import { VersionHistoryDialog } from "./VersionHistoryDialog.tsx";

const listTurns = vi.fn();
const undoTurn = vi.fn();
const ID1 = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  listTurns.mockReset().mockResolvedValue([
    { id: ID1, turn: 1, createdAt: "2026-10-24T18:40:00Z", kind: "turn", prompt: "сделай сайт" },
    { id: ID2, turn: 2, createdAt: "2026-10-25T10:05:00Z", kind: "turn", prompt: "добавь меню" },
  ]);
  undoTurn.mockReset();
  (window as unknown as { zeno: unknown }).zeno = { prsloy: { listTurns, undoTurn } };
});
afterEach(cleanup);

describe("VersionHistoryDialog", () => {
  it("lists versions newest first and goes back after a confirm", async () => {
    undoTurn.mockResolvedValue({
      restoredTo: { id: ID1 },
      backup: { id: "b" },
      rewritten: ["index.html"],
      removed: ["menu.js", "menu.css"],
    });
    render(<VersionHistoryDialog locale="ru" open running={false} onClose={() => {}} />);
    const rows = await screen.findAllByTestId("version-history-row");
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("добавь меню"),
      expect.stringContaining("сделай сайт"),
    ]);
    fireEvent.click(screen.getAllByTestId("version-history-restore")[1]!);
    expect(screen.getByTestId("version-history-confirm").textContent).toContain(
      "Файлы станут как до «сделай сайт»",
    );
    expect(undoTurn).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByText("Вернуть", { selector: "[data-testid=version-history-confirm] *" }),
    );
    await waitFor(() => expect(undoTurn).toHaveBeenCalledWith(ID1));
    expect((await screen.findByTestId("version-history-note")).textContent).toBe(
      "Ход откачен: вернул 3 файла",
    );
    expect(loadUndoOutcome(ID1)).toEqual({ kind: "undone", count: 3, backupId: "b" });
    await waitFor(() => expect(listTurns).toHaveBeenCalledTimes(2));
  });

  it("waits while the agent works, and says when there is nothing yet", async () => {
    render(<VersionHistoryDialog locale="ru" open running onClose={() => {}} />);
    const buttons = await screen.findAllByTestId("version-history-restore");
    expect(buttons.every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
    expect(screen.getByText("Сначала остановите агента")).toBeTruthy();
    cleanup();
    listTurns.mockResolvedValue([]);
    render(<VersionHistoryDialog locale="ru" open running={false} onClose={() => {}} />);
    expect((await screen.findByTestId("version-history-empty")).textContent).toBe(
      "Версий пока нет: они появятся после первой просьбы.",
    );
  });

  it("shows core's refusal in plain words", async () => {
    undoTurn.mockRejectedValue(new Error("Stop the agent before undoing a turn"));
    render(<VersionHistoryDialog locale="ru" open running={false} onClose={() => {}} />);
    fireEvent.click((await screen.findAllByTestId("version-history-restore"))[0]!);
    fireEvent.click(
      screen.getByText("Вернуть", { selector: "[data-testid=version-history-confirm] *" }),
    );
    expect((await screen.findByRole("alert")).textContent).toContain("Не получилось откатить");
  });
});
