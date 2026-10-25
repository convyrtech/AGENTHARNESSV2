import { describe, expect, it } from "vite-plus/test";
import { agentProcesses, processName, uptimeLabel } from "./agent-processes.ts";
import type { TimelineItem } from "./timeline.ts";

const tool = (name: string, args: unknown, details: unknown, status = "completed"): TimelineItem =>
  ({
    id: `t${Math.random()}`,
    kind: "tool",
    toolName: name,
    status,
    args,
    details,
    timestamp: "2026-10-25T10:00:00.000Z",
  }) as TimelineItem;

describe("agent processes from the chat", () => {
  it("reads bash_background and server commands the harness moved to its registry", () => {
    const items = [
      tool(
        "bash_background",
        { command: "python bot.py" },
        { id: "bg1", pid: 101, logPath: "/t/bg1.log", ports: [] },
      ),
      tool(
        "bash",
        { command: "python -m http.server 8080" },
        {
          prsloyServer: true,
          servers: [{ id: "bg2", pid: 102, logPath: "/t/bg2.log", ports: [8080] }],
        },
      ),
      tool("bash_background", { command: "x" }, { id: "bg1", pid: 101, logPath: "/t/bg1.log" }),
      tool("bash_background", { command: "y" }, { pid: "nope", logPath: "/t/bg9.log" }),
      tool("bash_background", { command: "z" }, { pid: 5, logPath: "/t/bg5.log" }, "error"),
      tool("bash", { command: "ls" }, undefined),
    ];
    const procs = agentProcesses(items);
    expect(procs.map((p) => [p.id, p.pid, p.ports])).toEqual([
      ["bg1", 101, []],
      ["bg2", 102, [8080]],
    ]);
    expect(procs[0]?.command).toBe("python bot.py");
    expect(procs[0]?.startedAt).toBe(Date.parse("2026-10-25T10:00:00.000Z"));
  });

  it("names them for a person", () => {
    const base = { key: "k", id: "bg1", pid: 1, logPath: "k", ports: [] as number[] };
    expect(processName("ru", { ...base, command: "python bot.py" })).toBe("Бот Telegram");
    expect(processName("ru", { ...base, command: "npm run dev", ports: [5173] })).toBe(
      "Сайт на 127.0.0.1:5173",
    );
    expect(
      processName("ru", { ...base, command: "node watch.js --all --verbose --forever --and-more" }),
    ).toBe("Команда: node watch.js --all --verbose --forever …");
  });

  it("says how long it runs", () => {
    const at = Date.parse("2026-10-25T10:00:00Z");
    expect(uptimeLabel("ru", at, at + 30_000)).toBe("работает меньше минуты");
    expect(uptimeLabel("ru", at, at + 5 * 60_000)).toBe("работает 5 мин");
    expect(uptimeLabel("ru", at, at + 80 * 60_000)).toBe("работает 1 ч 20 мин");
  });
});
