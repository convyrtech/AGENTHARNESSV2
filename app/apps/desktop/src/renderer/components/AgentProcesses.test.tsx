// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { TimelineItem } from "../lib/timeline.ts";
import { AgentProcesses } from "./AgentProcesses.tsx";

const features = { procStatus: vi.fn(), procLog: vi.fn(), procStop: vi.fn() };
const items = [
  {
    id: "t1",
    kind: "tool",
    toolName: "bash_background",
    status: "completed",
    args: { command: "python bot.py" },
    details: { id: "bg1", pid: 101, logPath: "/tmp/prsloy-harness/bg-9-a/bg1.log", ports: [] },
    timestamp: new Date().toISOString(),
  },
  {
    id: "t2",
    kind: "tool",
    toolName: "bash_background",
    status: "completed",
    args: { command: "python -m http.server 8099" },
    details: { id: "bg2", pid: 102, logPath: "/tmp/prsloy-harness/bg-9-a/bg2.log", ports: [8099] },
  },
] as TimelineItem[];

beforeEach(() => {
  features.procStatus.mockReset().mockResolvedValue([
    { pid: 101, alive: true },
    { pid: 102, alive: false },
  ]);
  features.procLog.mockReset().mockResolvedValue("Бот запущен\nпривет");
  features.procStop.mockReset().mockResolvedValue({ ok: true });
  (window as unknown as { zeno: unknown }).zeno = { features };
});
afterEach(cleanup);

describe("AgentProcesses", () => {
  it("shows what still runs, by a person's name", async () => {
    render(<AgentProcesses locale="ru" items={items} />);
    const row = await screen.findByTestId("agent-proc");
    expect(row.textContent).toContain("Бот Telegram");
    expect(row.textContent).toContain("работает меньше минуты");
    expect(screen.getAllByTestId("agent-proc")).toHaveLength(1);
    expect(features.procStatus).toHaveBeenCalledWith([101, 102]);
  });

  it("opens the log and stops the process", async () => {
    render(<AgentProcesses locale="ru" items={items} />);
    fireEvent.click(await screen.findByTestId("agent-proc-log-toggle"));
    expect((await screen.findByTestId("agent-proc-log")).textContent).toBe("Бот запущен\nпривет");
    expect(features.procLog).toHaveBeenCalledWith("/tmp/prsloy-harness/bg-9-a/bg1.log");
    fireEvent.click(screen.getByTestId("agent-proc-stop"));
    await waitFor(() =>
      expect(features.procStop).toHaveBeenCalledWith(101, "/tmp/prsloy-harness/bg-9-a/bg1.log"),
    );
    expect((await screen.findByTestId("agent-proc-status")).textContent).toBe("остановлен");
    expect(screen.queryByTestId("agent-proc-stop")).toBeNull();
  });

  it("says plainly when it may not stop it", async () => {
    features.procStop.mockResolvedValue({ ok: false, reason: "not_ours" });
    render(<AgentProcesses locale="ru" items={items} />);
    fireEvent.click(await screen.findByTestId("agent-proc-stop"));
    expect((await screen.findByRole("alert")).textContent).toContain("остановить его здесь нельзя");
  });

  it("renders nothing when nothing runs or main cannot tell", async () => {
    features.procStatus.mockResolvedValue([]);
    const { container } = render(<AgentProcesses locale="ru" items={items} />);
    await waitFor(() => expect(features.procStatus).toHaveBeenCalled());
    expect(container.textContent).toBe("");
    cleanup();
    (window as unknown as { zeno: unknown }).zeno = {};
    expect(render(<AgentProcesses locale="ru" items={items} />).container.textContent).toBe("");
  });
});
