// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { TimelineItem } from "../lib/timeline.ts";
import { TOOL_STALL_MS } from "../lib/tool-state.ts";
import { TimelineRow } from "./TimelineRow.tsx";

afterEach(cleanup);

const now = Date.now();
const at = (offsetMs: number) => new Date(now + offsetMs).toISOString();

function tool(over: Partial<Extract<TimelineItem, { kind: "tool" }>>): TimelineItem {
  return {
    id: "t1",
    kind: "tool",
    toolName: "bash",
    status: "running",
    args: { command: "sleep 100" },
    ...over,
  } as TimelineItem;
}

function cardText(): string {
  return document.querySelector("article[data-kind='tool']")?.textContent ?? "";
}

describe("tool card states (#82)", () => {
  it("shows «Выполняется» and a live clock for a fresh call", () => {
    render(
      <TimelineRow item={tool({ timestamp: at(-2_000) })} locale="ru" editingLocked={false} />,
    );
    const card = cardText();
    expect(card).toContain("Выполняется");
    expect(card).toContain("2 с");
  });

  it("shows «Зависло» once the call runs past the stall threshold", () => {
    render(
      <TimelineRow
        item={tool({ timestamp: at(-(TOOL_STALL_MS + 5_000)) })}
        locale="ru"
        editingLocked={false}
      />,
    );
    expect(cardText()).toContain("Зависло");
  });

  it("shows «Ждёт ответа» for a tool that waits on the person", () => {
    render(
      <TimelineRow
        item={tool({ toolName: "ask_user", args: { question: "Куда?" }, timestamp: at(-500) })}
        locale="ru"
        editingLocked={false}
      />,
    );
    expect(cardText()).toContain("Ждёт ответа");
  });

  it("says «Таймаут» when the call stopped by timeout", () => {
    render(
      <TimelineRow
        item={tool({
          status: "error",
          timestamp: at(-5_200),
          endedAt: at(-100),
          output: "Command timed out after 5 seconds",
        })}
        locale="ru"
        editingLocked={false}
      />,
    );
    expect(cardText()).toContain("Таймаут");
  });

  it("says «Отменено» when the owner pressed Stop", () => {
    render(
      <TimelineRow
        item={tool({
          status: "error",
          timestamp: at(-4_000),
          endedAt: at(-100),
          output: "sleep 100\n\nCommand aborted",
        })}
        locale="ru"
        editingLocked={false}
      />,
    );
    expect(cardText()).toContain("Отменено");
  });

  it("keeps «Ошибка» for a real failure and «Готово» for success", () => {
    render(
      <TimelineRow
        item={tool({
          status: "error",
          timestamp: at(-100),
          endedAt: at(-10),
          args: { command: "nope" },
          output: "bash: nope: command not found",
        })}
        locale="ru"
        editingLocked={false}
      />,
    );
    expect(cardText()).toContain("Ошибка");
    cleanup();
    render(
      <TimelineRow
        item={tool({ status: "completed", timestamp: at(-100), endedAt: at(-10), output: "ok" })}
        locale="ru"
        editingLocked={false}
      />,
    );
    expect(cardText()).toContain("Готово");
  });
});
