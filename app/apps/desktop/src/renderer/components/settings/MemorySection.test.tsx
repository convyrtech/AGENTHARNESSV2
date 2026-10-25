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
    render(<MemorySection tr={tr} locale="ru" workspace="/home/u/site" />);
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
    render(<MemorySection tr={tr} locale="ru" workspace={undefined} />);
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
    render(<MemorySection tr={tr} locale="ru" workspace={undefined} />);
    const toggle = await screen.findByTestId("settings-memory-toggle");
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    expect(screen.getByText("Сейчас выключено: агент ничего не запоминает.")).toBeTruthy();
    fireEvent.click(toggle);
    await waitFor(() => expect(flags.set).toHaveBeenCalledWith({ memory: true }));
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  });

  it("says so while main has no memory yet", () => {
    (window as unknown as { zeno: unknown }).zeno = { harnessFlags: flags };
    render(<MemorySection tr={tr} locale="ru" workspace={undefined} />);
    expect(screen.getByTestId("memory-unavailable").textContent).toBe(
      "Память пока недоступна в этой версии приложения.",
    );
  });
});

describe("Settings → Память, v2 (research/24 §3.6)", () => {
  const v2 = {
    user: [
      {
        id: "u-1",
        text: "Отвечать коротко",
        origin: "auto",
        quote: "пиши короче",
        created: "2026-10-12T10:00:00Z",
      },
      { id: "u-2", text: "Без английских слов", origin: "user", pinned: true },
    ],
    project: [],
    forgotten: [],
    history: [
      {
        opId: "op-9",
        scope: "user",
        kind: "replaced",
        text: "Тёмные сайты",
        now: "Светлые сайты",
        at: "2026-10-20T10:00:00Z",
      },
    ],
  };

  beforeEach(() => {
    localStorage.clear();
    api.list.mockResolvedValue(v2);
    (api as Record<string, unknown>).pin = vi.fn().mockResolvedValue(v2);
    (api as Record<string, unknown>).revert = vi.fn().mockResolvedValue({ ...v2, history: [] });
    flags.get.mockResolvedValue({ secondOpinion: true, memory: true, autoMemory: "off" });
  });

  it("says who it came from, when and in which words; pins; brings back from «Было»", async () => {
    render(<MemorySection tr={tr} locale="ru" workspace="/p" />);
    const rows = await screen.findAllByTestId("memory-user-row");
    expect(rows[0]?.textContent).toMatch(/заметил сам · 12 окт\.? · Ваши слова: «пиши короче»/u);
    expect(rows[1]?.textContent).toContain("вы просили");
    const pins = screen.getAllByTestId("memory-user-pin");
    expect(pins.map((b) => b.textContent)).toEqual(["Закрепить", "Открепить"]);
    fireEvent.click(pins[0]!);
    await waitFor(() =>
      expect((api as unknown as { pin: ReturnType<typeof vi.fn> }).pin).toHaveBeenCalledWith(
        "u-1",
        true,
        "/p",
      ),
    );
    const history = screen.getByTestId("memory-history");
    expect(history.textContent).toContain("Было");
    expect(history.textContent).toContain("заменено, теперь «Светлые сайты»");
    fireEvent.click(screen.getByTestId("memory-history-revert"));
    await waitFor(() =>
      expect((api as unknown as { revert: ReturnType<typeof vi.fn> }).revert).toHaveBeenCalledWith(
        "op-9",
        "/p",
      ),
    );
  });

  it("«Замечать важное само»: the first time a card with [Выключить], which turns it off", async () => {
    render(<MemorySection tr={tr} locale="ru" workspace="/p" />);
    const auto = await screen.findByTestId("settings-memory-auto-toggle");
    await waitFor(() => expect((auto as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(auto);
    await waitFor(() => expect(flags.set).toHaveBeenCalledWith({ autoMemory: true }));
    expect(screen.getByTestId("memory-auto-intro").textContent).toContain(
      "Теперь замечаю важное в ваших словах сам",
    );
    fireEvent.click(screen.getByTestId("memory-auto-intro-off"));
    await waitFor(() => expect(flags.set).toHaveBeenCalledWith({ autoMemory: "off" }));
    expect(screen.queryByTestId("memory-auto-intro")).toBeNull();
  });

  it("no [Закрепить] while core serves memory v1; «само» waits for memory to be on", async () => {
    api.list.mockResolvedValue({ user: [{ id: "u-1", text: "А" }], project: [], forgotten: [] });
    flags.get.mockResolvedValue({ secondOpinion: true, memory: false, autoMemory: "off" });
    render(<MemorySection tr={tr} locale="ru" workspace="/p" />);
    await screen.findAllByTestId("memory-user-row");
    expect(screen.queryByTestId("memory-user-pin")).toBeNull();
    await waitFor(() =>
      expect(
        (screen.getByTestId("settings-memory-auto-toggle") as HTMLButtonElement).disabled,
      ).toBe(true),
    );
  });
});
