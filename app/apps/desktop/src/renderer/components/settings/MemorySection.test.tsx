// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { t } from "../../lib/i18n.ts";
import { MemorySection } from "./MemorySection.tsx";

const tr = (key: Parameters<typeof t>[1], vars?: Record<string, string>) => t("ru", key, vars);
const full = {
  user: [{ id: "u-1", text: "Отвечать коротко, без терминов" }],
  project: [{ id: "p-1", text: "Сайт без сборщиков" }],
  digest: { text: "Прошлый раз: правили index.html.", updated: "2026-10-25T10:00:00Z" },
  forgotten: [
    { id: "u-0", scope: "user", text: "Звать меня Ваня", forgotten: "2026-10-25T09:00:00Z" },
  ],
};
const api = { list: vi.fn(), forget: vi.fn(), restore: vi.fn(), forgetAll: vi.fn() };
const flags = { get: vi.fn(), set: vi.fn() };

beforeEach(() => {
  api.list.mockReset().mockResolvedValue(full);
  api.forget.mockReset().mockResolvedValue({ ...full, user: [] });
  api.restore.mockReset().mockResolvedValue(full);
  api.forgetAll.mockReset().mockResolvedValue({ user: [], project: [], forgotten: [] });
  flags.get.mockReset().mockResolvedValue({ secondOpinion: true, memory: false });
  flags.set
    .mockReset()
    .mockImplementation((p: object) => Promise.resolve({ secondOpinion: true, ...p }));
  (window as unknown as { zeno: unknown }).zeno = { memory: api, harnessFlags: flags };
});
afterEach(cleanup);

describe("Settings → Память", () => {
  it("shows what the agent remembers, forgets one, restores one", async () => {
    render(<MemorySection tr={tr} workspace="/home/u/site" />);
    const user = await screen.findByTestId("memory-user");
    expect(user.textContent).toContain("Обо мне");
    expect(user.textContent).toContain("Отвечать коротко, без терминов");
    expect(screen.getByTestId("memory-project").textContent).toContain("Сайт без сборщиков");
    expect(screen.getByTestId("memory-digest").textContent).toContain("Прошлый раз");
    expect(api.list).toHaveBeenCalledWith("/home/u/site");
    fireEvent.click(within(user).getByTestId("memory-user-forget"));
    await waitFor(() => expect(api.forget).toHaveBeenCalledWith("u-1", "/home/u/site"));
    await waitFor(() =>
      expect(screen.getByTestId("memory-user").textContent).toContain("Пока пусто."),
    );
    fireEvent.click(screen.getByTestId("memory-forgotten-restore"));
    await waitFor(() => expect(api.restore).toHaveBeenCalledWith("u-0", "/home/u/site"));
  });

  it("«Забыть всё» only after the confirm", async () => {
    render(<MemorySection tr={tr} workspace={undefined} />);
    expect((await screen.findByTestId("memory-project")).textContent).toContain("Откройте проект");
    fireEvent.click(screen.getByTestId("memory-forget-all"));
    expect(screen.getByTestId("memory-forget-all-confirm").textContent).toContain(
      "Отменить нельзя",
    );
    expect(api.forgetAll).not.toHaveBeenCalled();
    fireEvent.click(
      within(screen.getByTestId("memory-forget-all-confirm")).getByText("Забыть всё"),
    );
    await waitFor(() => expect(api.forgetAll).toHaveBeenCalled());
  });

  it("the switch writes the harness flag; off by default", async () => {
    render(<MemorySection tr={tr} workspace={undefined} />);
    const toggle = await screen.findByTestId("settings-memory-toggle");
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    expect(screen.getByText("Сейчас выключено: агент ничего не запоминает.")).toBeTruthy();
    fireEvent.click(toggle);
    await waitFor(() => expect(flags.set).toHaveBeenCalledWith({ memory: true }));
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  });

  it("says so while main has no memory yet", () => {
    (window as unknown as { zeno: unknown }).zeno = { harnessFlags: flags };
    render(<MemorySection tr={tr} workspace={undefined} />);
    expect(screen.getByTestId("memory-unavailable").textContent).toBe(
      "Память пока недоступна в этой версии приложения.",
    );
  });
});
