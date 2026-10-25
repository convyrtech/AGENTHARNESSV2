import { describe, expect, it } from "vite-plus/test";
import { buildTimelineBlocks, type TimelineItem } from "./timeline.ts";
import { previewTargetLabel, previewTargetOfTool, previewTargetsByBlock } from "./turn-preview.ts";

let n = 0;
function tool(toolName: string, extra: Partial<Extract<TimelineItem, { kind: "tool" }>> = {}) {
  return { id: `t${++n}`, kind: "tool", toolName, status: "completed", ...extra } as TimelineItem;
}
const user = (text: string) => ({ id: `u${++n}`, kind: "user", text }) as TimelineItem;
const reply = (text: string) => ({ id: `a${++n}`, kind: "assistant", text }) as TimelineItem;

describe("previewTargetOfTool", () => {
  it("takes a written or edited html page", () => {
    expect(previewTargetOfTool(tool("write", { args: { path: "site/index.html" } }))).toEqual({
      kind: "file",
      path: "site/index.html",
    });
    expect(previewTargetOfTool(tool("edit", { args: { file_path: "/p/about.HTM" } }))).toEqual({
      kind: "file",
      path: "/p/about.HTM",
    });
  });

  it("ignores other files, failed or running writes", () => {
    expect(previewTargetOfTool(tool("write", { args: { path: "style.css" } }))).toBeUndefined();
    expect(
      previewTargetOfTool(tool("write", { args: { path: "a.html" }, status: "error" })),
    ).toBeUndefined();
    expect(
      previewTargetOfTool(tool("write", { args: { path: "a.html" }, status: "running" })),
    ).toBeUndefined();
    expect(previewTargetOfTool(tool("read", { args: { path: "a.html" } }))).toBeUndefined();
  });

  it("takes a server port from the registry's structured details", () => {
    expect(
      previewTargetOfTool(tool("bash_background", { details: { id: "p1", ports: [5173] } })),
    ).toEqual({ kind: "server", port: 5173 });
  });

  it("takes the port from details on a server-like bash too, never from the text", () => {
    expect(
      previewTargetOfTool(
        tool("bash", { status: "error", details: { id: "p2", ports: [8000], prsloyServer: true } }),
      ),
    ).toEqual({ kind: "server", port: 8000 });
    expect(
      previewTargetOfTool(tool("bash", { output: "p3: работает, pid 7, порт 3000, лог /x" })),
    ).toBeUndefined();
  });

  it("does not take a server that reports no port", () => {
    expect(
      previewTargetOfTool(tool("bash_background", { details: { ports: [] } })),
    ).toBeUndefined();
    expect(previewTargetOfTool(tool("bash", { output: "listening on :8000" }))).toBeUndefined();
  });
});

describe("previewTargetsByBlock", () => {
  it("puts the action after each finished turn, server over file", () => {
    const items = [
      user("Сделай сайт-визитку"),
      tool("write", { args: { path: "site/index.html" } }),
      reply("Готово"),
      user("Запусти"),
      tool("write", { args: { path: "site/index.html" } }),
      tool("bash_background", { details: { ports: [4173] } }),
      reply("Запустил"),
      user("Что это за проект?"),
      reply("Лендинг"),
    ];
    const blocks = buildTimelineBlocks(items);
    const targets = [...previewTargetsByBlock(blocks, false).values()];
    expect(targets).toEqual([
      { kind: "file", path: "site/index.html" },
      { kind: "server", port: 4173 },
    ]);
  });

  it("waits for the running turn to finish", () => {
    const blocks = buildTimelineBlocks([
      user("Сделай сайт"),
      tool("write", { args: { path: "index.html" } }),
    ]);
    expect(previewTargetsByBlock(blocks, true).size).toBe(0);
    expect(previewTargetsByBlock(blocks, false).size).toBe(1);
  });
});

describe("previewTargetLabel", () => {
  it("shows the file name or the loopback address", () => {
    expect(previewTargetLabel({ kind: "file", path: "/home/u/site/index.html" })).toBe(
      "index.html",
    );
    expect(previewTargetLabel({ kind: "file", path: "C:\\site\\about.html" })).toBe("about.html");
    expect(previewTargetLabel({ kind: "server", port: 5173 })).toBe("127.0.0.1:5173");
  });
});
