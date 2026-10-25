// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { ImportProgress, ImportScanResult } from "@zeno/contracts";
import { ImportChats } from "./ImportChats.tsx";

afterEach(cleanup);

const zero = { chats: 0, projects: 0, recent: 0 };
const found: ImportScanResult = {
  counts: { "claude-code": { chats: 2, projects: 1, recent: 2 }, codex: zero, "pi-cli": zero },
  chats: [
    {
      key: "claude-code:a",
      tool: "claude-code",
      title: "Сайт",
      project: "C:\\Проекты\\сайт",
      updatedAt: 2,
      alreadyImported: false,
    },
    {
      key: "claude-code:b",
      tool: "claude-code",
      title: "Ещё",
      project: "C:\\Проекты\\сайт",
      updatedAt: 1,
      alreadyImported: false,
    },
    {
      key: "codex:c",
      tool: "codex",
      title: "Бот",
      project: "C:\\Проекты\\бот",
      updatedAt: 0,
      alreadyImported: false,
    },
  ],
  selected: ["claude-code:a", "claude-code:b"],
};

function mockImport(scan: ImportScanResult | Error) {
  let progress: ((p: ImportProgress) => void) | undefined;
  const api = {
    scan: scan instanceof Error ? vi.fn().mockRejectedValue(scan) : vi.fn().mockResolvedValue(scan),
    run: vi.fn(async (keys: string[]) => {
      progress?.({ done: 1, total: keys.length });
      return {
        imported: keys.length,
        skipped: { "no-project": 1 },
        projects: ["C:\\Проекты\\сайт"],
      };
    }),
    onProgress: vi.fn((listener: (p: ImportProgress) => void) => {
      progress = listener;
      return () => {
        progress = undefined;
      };
    }),
  };
  (window as unknown as { zeno: unknown }).zeno = { sessionImport: api };
  return api;
}

describe("ImportChats", () => {
  it("offers each tool with counts, brings the ticked ones over and says how many", async () => {
    localStorage.clear();
    const api = mockImport(found);
    const onDone = vi.fn();
    render(<ImportChats locale="ru" mode="first-run" onDone={onDone} />);
    const claude = await screen.findByTestId("prsloy-import-tool-claude-code");
    expect(claude.textContent).toBe("Claude Code2 чата в 1 проекте");
    expect((claude.querySelector("input") as HTMLInputElement).checked).toBe(true);
    const codex = screen.getByTestId("prsloy-import-tool-codex");
    expect((codex.querySelector("input") as HTMLInputElement).checked).toBe(false);
    expect(screen.getByRole("heading").textContent).toBe("Перенести чаты из других программ?");

    fireEvent.click(codex.querySelector("input")!);
    fireEvent.click(screen.getByTestId("prsloy-import-submit"));
    expect(await screen.findByTestId("prsloy-import-result")).toHaveProperty(
      "textContent",
      "Перенёс 3 чата",
    );
    expect(api.run).toHaveBeenCalledWith(["claude-code:a", "claude-code:b", "codex:c"]);
    expect(screen.getByText(/Не перенёс: 1/u)).toBeTruthy();
    expect(JSON.parse(localStorage.getItem("prsloy.import.projects")!)).toEqual([
      "C:\\Проекты\\сайт",
    ]);
    expect(onDone).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("prsloy-import-next"));
    expect(onDone).toHaveBeenCalledOnce();
  });

  it("«Не сейчас» leaves without importing", async () => {
    const api = mockImport(found);
    const onDone = vi.fn();
    render(<ImportChats locale="ru" mode="first-run" onDone={onDone} />);
    fireEvent.click(await screen.findByTestId("prsloy-import-later"));
    expect(onDone).toHaveBeenCalledOnce();
    expect(api.run).not.toHaveBeenCalled();
  });

  it("disables «Перенести» when nothing is ticked", async () => {
    mockImport(found);
    render(<ImportChats locale="ru" mode="first-run" onDone={vi.fn()} />);
    const claude = await screen.findByTestId("prsloy-import-tool-claude-code");
    fireEvent.click(claude.querySelector("input")!);
    expect((screen.getByTestId("prsloy-import-submit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("steps aside on the first run when nothing is found, the scan fails, or main has no import", async () => {
    const empty = { ...found, chats: found.chats.map((c) => ({ ...c, alreadyImported: true })) };
    for (const scan of [empty, new Error("boom")]) {
      mockImport(scan);
      const onDone = vi.fn();
      render(<ImportChats locale="ru" mode="first-run" onDone={onDone} />);
      await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
      cleanup();
    }
    (window as unknown as { zeno: unknown }).zeno = {};
    const onDone = vi.fn();
    render(<ImportChats locale="ru" mode="first-run" onDone={onDone} />);
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
  });

  it("in settings says nothing was found instead of stepping aside", async () => {
    mockImport({ ...found, chats: [] });
    const onDone = vi.fn();
    render(<ImportChats locale="ru" mode="settings" onDone={onDone} />);
    expect(await screen.findByText("Чатов из других программ не нашёл.")).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading")).toBeNull();
  });

  it("shows a failed run as an error and still lets you go on", async () => {
    const api = mockImport(found);
    api.run.mockRejectedValueOnce(new Error("an import is already running"));
    render(<ImportChats locale="ru" mode="first-run" onDone={vi.fn()} />);
    fireEvent.click(await screen.findByTestId("prsloy-import-submit"));
    expect((await screen.findByRole("alert")).textContent).toContain("Не получилось перенести");
    expect(screen.getByTestId("prsloy-import-next")).toBeTruthy();
  });
});
