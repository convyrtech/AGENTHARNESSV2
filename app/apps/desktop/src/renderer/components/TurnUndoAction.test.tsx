// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { t } from "../lib/i18n.ts";
import { TurnUndoAction } from "./TurnUndoAction.tsx";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function mockUndo(impl: (id: string) => Promise<unknown>) {
  const undoTurn = vi.fn(impl);
  (window as unknown as { zeno: unknown }).zeno = { prsloy: { undoTurn } };
  return undoTurn;
}

describe("TurnUndoAction", () => {
  it("confirms, restores the snapshot and says how many files came back", async () => {
    const undoTurn = mockUndo(async (id) => ({
      restoredTo: { id, turn: 2, createdAt: "", kind: "turn" },
      backup: { id: "backup-1", turn: 2, createdAt: "", kind: "undo-backup" },
      rewritten: ["a.html", "b.css"],
      removed: ["c.js"],
    }));
    render(<TurnUndoAction locale="ru" snapshotId="snap-2" disabled={false} />);
    fireEvent.click(screen.getByTestId("turn-undo-btn"));
    expect(await screen.findByText(t("ru", "prsloy.undo.confirmMessage"))).toBeTruthy();
    expect(undoTurn).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: t("ru", "prsloy.undo.short") }));
    expect((await screen.findByTestId("turn-undo-result")).textContent).toBe(
      "Ход откачен: вернул 3 файла",
    );
    expect(undoTurn).toHaveBeenCalledWith("snap-2");

    fireEvent.click(screen.getByTestId("turn-undo-restore"));
    expect(await screen.findByText(t("ru", "prsloy.undo.restored"))).toBeTruthy();
    expect(undoTurn).toHaveBeenLastCalledWith("backup-1");
  });

  it("shows a past undo again after a remount", async () => {
    mockUndo(async (id) => ({
      restoredTo: { id, turn: 1, createdAt: "", kind: "turn" },
      rewritten: ["a.html"],
      removed: [],
    }));
    render(<TurnUndoAction locale="ru" snapshotId="snap-9" disabled={false} />);
    fireEvent.click(screen.getByTestId("turn-undo-btn"));
    fireEvent.click(await screen.findByRole("button", { name: t("ru", "prsloy.undo.short") }));
    await screen.findByTestId("turn-undo-result");
    cleanup();
    render(<TurnUndoAction locale="ru" snapshotId="snap-9" disabled={false} />);
    expect(screen.getByTestId("turn-undo-result").textContent).toBe("Ход откачен: вернул 1 файл");
  });

  it("is disabled while a turn runs", () => {
    mockUndo(async () => ({}));
    render(<TurnUndoAction locale="ru" snapshotId="s" disabled />);
    expect((screen.getByTestId("turn-undo-btn") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the reason when main refuses", async () => {
    mockUndo(async () => {
      throw new Error("agent busy");
    });
    render(<TurnUndoAction locale="ru" snapshotId="s" disabled={false} />);
    fireEvent.click(screen.getByTestId("turn-undo-btn"));
    fireEvent.click(await screen.findByRole("button", { name: t("ru", "prsloy.undo.short") }));
    expect((await screen.findByRole("alert")).textContent).toContain("agent busy");
  });
});
