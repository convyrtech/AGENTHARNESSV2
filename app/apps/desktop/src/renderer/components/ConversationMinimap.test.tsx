// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ConversationMinimap } from "./ConversationMinimap.tsx";
import type { TimelineItem } from "@/lib/timeline";

const { scrollToMessage, minimapState } = vi.hoisted(() => ({
  scrollToMessage: vi.fn(),
  minimapState: { visibleMessageIds: [] as string[] },
}));

vi.mock("@/components/ui/message-scroller", () => ({
  useMessageScroller: () => ({ scrollToMessage }),
  useMessageScrollerScrollable: () => ({ start: true, end: false }),
  useMessageScrollerVisibility: () => ({ visibleMessageIds: minimapState.visibleMessageIds }),
}));

vi.mock("./timeline-window-context.tsx", () => ({
  useTimelineWindow: () => ({ isRendered: () => true, showAll: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  scrollToMessage.mockClear();
  minimapState.visibleMessageIds = [];
  vi.unstubAllGlobals();
});

let resizeObserverCallback: ResizeObserverCallback | undefined;

beforeEach(() => {
  resizeObserverCallback = undefined;
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resizeObserverCallback = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

const items: TimelineItem[] = [
  { id: "u1", kind: "user", text: "First question" },
  { id: "a1", kind: "assistant", text: "First answer" },
  { id: "u2", kind: "user", text: "Second question" },
  { id: "a2", kind: "assistant", text: "Second answer" },
];

function renderMinimap() {
  return render(<ConversationMinimap items={items} locale="en" />);
}

describe("ConversationMinimap", () => {
  it("exposes one accessible slider and renders no marker buttons", () => {
    renderMinimap();

    const slider = screen.getByRole("slider", { name: "Conversation minimap" });
    expect(slider).toHaveAttribute("min", "0");
    expect(slider).toHaveAttribute("max", "3");
    expect(slider).toHaveAttribute(
      "aria-valuetext",
      expect.stringContaining("User message, 1 / 4"),
    );
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(document.querySelectorAll(".minimap-marker")).toHaveLength(4);
  });

  it("selects and jumps to the marker named by the range value", () => {
    renderMinimap();

    fireEvent.change(screen.getByRole("slider"), { target: { value: "2" } });

    expect(scrollToMessage).toHaveBeenCalledExactlyOnceWith(
      "u2",
      expect.objectContaining({ align: "start" }),
    );
    expect(screen.getByRole("slider")).toHaveAttribute(
      "aria-valuetext",
      expect.stringContaining("User message, 3 / 4"),
    );
  });

  it("follows the visible marker after an intentional selection loses focus", () => {
    const view = renderMinimap();
    const slider = screen.getByRole("slider");

    expect(slider).toHaveValue("0");
    expect(document.querySelector(".minimap-marker.selected")).toBeNull();

    minimapState.visibleMessageIds = ["a1"];
    view.rerender(<ConversationMinimap items={[...items]} locale="en" />);
    expect(slider).toHaveValue("1");
    expect(document.querySelector(".minimap-marker.active")).toHaveClass("assistant");

    fireEvent.change(slider, { target: { value: "2" } });
    expect(slider).toHaveValue("2");
    expect(document.querySelector(".minimap-marker.selected")).toHaveClass("user");

    fireEvent.blur(slider);
    minimapState.visibleMessageIds = ["a1"];
    view.rerender(<ConversationMinimap items={[...items]} locale="en" />);

    expect(slider).toHaveValue("1");
    expect(slider).toHaveAttribute(
      "aria-valuetext",
      expect.stringContaining("Assistant reply, 2 / 4"),
    );
    expect(document.querySelector(".minimap-marker.selected")).toBeNull();
  });

  it("keeps a middle preview aligned with its marker after the rail resizes", () => {
    renderMinimap();
    const rail = document.querySelector<HTMLElement>(".minimap-rail")!;
    let railHeight = 200;
    let center = 100;
    Object.defineProperty(rail, "clientHeight", { configurable: true, get: () => railHeight });
    const marker = document.querySelectorAll<HTMLElement>(".minimap-marker")[2]!;
    vi.spyOn(marker, "getBoundingClientRect").mockImplementation(() => ({
      x: 0,
      y: center - 4,
      top: center - 4,
      left: 0,
      right: 13,
      bottom: center + 4,
      width: 13,
      height: 8,
      toJSON: () => ({}),
    }));
    act(() => resizeObserverCallback?.([], {} as ResizeObserver));
    fireEvent.change(screen.getByRole("slider"), { target: { value: "2" } });
    const popover = document.querySelector<HTMLElement>(".minimap-popover")!;
    expect(popover).toHaveStyle({ top: "64px" });
    expect(popover).toHaveTextContent("Second question");
    center = 60;
    railHeight = 160;
    act(() => resizeObserverCallback?.([], {} as ResizeObserver));
    expect(popover).toHaveStyle({ top: "24px" });
    expect(popover).toHaveTextContent("Second question");
  });

  it("maps pointer position to a marker and prevents the native range pointer action", () => {
    renderMinimap();
    const rail = document.querySelector<HTMLElement>(".minimap-rail")!;
    const slider = screen.getByRole("slider");
    vi.spyOn(rail, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 10,
      top: 10,
      left: 0,
      right: 26,
      bottom: 110,
      width: 26,
      height: 100,
      toJSON: () => ({}),
    });
    Object.defineProperty(rail, "clientHeight", { configurable: true, value: 100 });

    const markerElements = [...document.querySelectorAll<HTMLElement>(".minimap-marker")];
    for (const [index, marker] of markerElements.entries()) {
      const center = [9.25, 34.5, 64.75, 89.5][index]!;
      vi.spyOn(marker, "getBoundingClientRect").mockReturnValue({
        x: 0,
        y: 10 + center - 4,
        top: 10 + center - 4,
        left: 0,
        right: 13,
        bottom: 10 + center + 4,
        width: 13,
        height: 8,
        toJSON: () => ({}),
      });
    }
    resizeObserverCallback?.([], {} as ResizeObserver);

    const wasNotCanceled = fireEvent.pointerDown(slider, { button: 0, clientY: 99.5 });

    expect(wasNotCanceled).toBe(false);
    expect(scrollToMessage).toHaveBeenCalledExactlyOnceWith(
      "a2",
      expect.objectContaining({ align: "start" }),
    );
  });
});
