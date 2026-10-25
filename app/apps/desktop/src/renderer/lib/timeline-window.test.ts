import { describe, expect, it } from "vite-plus/test";
import {
  nextTimelineLimit,
  TIMELINE_INITIAL_BLOCKS,
  TIMELINE_STEP_BLOCKS,
  timelineWindowStart,
} from "./timeline-window.ts";

describe("timeline window", () => {
  it("short chats render everything", () => {
    expect(timelineWindowStart(50, TIMELINE_INITIAL_BLOCKS)).toBe(0);
    expect(timelineWindowStart(TIMELINE_INITIAL_BLOCKS, TIMELINE_INITIAL_BLOCKS)).toBe(0);
  });

  it("long chats start with the tail and grow by a step", () => {
    expect(timelineWindowStart(1000, TIMELINE_INITIAL_BLOCKS)).toBe(800);
    const limit = nextTimelineLimit(TIMELINE_INITIAL_BLOCKS);
    expect(limit).toBe(TIMELINE_INITIAL_BLOCKS + TIMELINE_STEP_BLOCKS);
    expect(timelineWindowStart(1000, limit)).toBe(600);
  });

  it("Infinity = everything (minimap jump into the hidden part)", () => {
    expect(timelineWindowStart(1000, Number.POSITIVE_INFINITY)).toBe(0);
    expect(nextTimelineLimit(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
  });
});
