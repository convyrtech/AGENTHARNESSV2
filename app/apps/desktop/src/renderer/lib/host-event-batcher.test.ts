import { describe, expect, it } from "vite-plus/test";
import type { HostEvent } from "@zeno/contracts";
import { createHostEventBatcher, DELTA_FLUSH_MS, isStreamDelta } from "./host-event-batcher.ts";

const delta = (n: number, type: "message.delta" | "thinking.delta" = "message.delta") =>
  ({
    type: "runtime.event",
    runtimeId: "r",
    sequence: n,
    event: { type, delta: `w${n} ` },
  }) as HostEvent;
const settled = (n: number) =>
  ({
    type: "runtime.event",
    runtimeId: "r",
    sequence: n,
    event: { type: "agent.settled" },
  }) as HostEvent;

function fakeTimers() {
  const pending = new Map<number, () => void>();
  let next = 0;
  return {
    timers: {
      set: (fn: () => void, ms: number) => {
        expect(ms).toBe(DELTA_FLUSH_MS);
        next += 1;
        pending.set(next, fn);
        return next;
      },
      clear: (h: unknown) => void pending.delete(h as number),
    },
    fire() {
      const fns = [...pending.values()];
      pending.clear();
      for (const fn of fns) fn();
    },
    get count() {
      return pending.size;
    },
  };
}

describe("host event batcher", () => {
  it("delivers 2000 deltas as one batch per frame, in order", () => {
    const clock = fakeTimers();
    const batches: number[][] = [];
    const batcher = createHostEventBatcher(
      (events) => batches.push(events.map((e) => (e as { sequence: number }).sequence)),
      clock.timers,
    );
    for (let i = 0; i < 2000; i += 1)
      batcher.push(delta(i, i % 2 ? "thinking.delta" : "message.delta"));
    expect(batches).toEqual([]);
    expect(clock.count).toBe(1);
    clock.fire();
    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual(Array.from({ length: 2000 }, (_, i) => i));
  });

  it("flushes queued deltas before any other event, which runs at once", () => {
    const clock = fakeTimers();
    const seen: number[] = [];
    const batcher = createHostEventBatcher(
      (events) => seen.push(...events.map((e) => (e as { sequence: number }).sequence)),
      clock.timers,
    );
    batcher.push(delta(1));
    batcher.push(delta(2));
    batcher.push(settled(3));
    expect(seen).toEqual([1, 2, 3]);
    expect(clock.count).toBe(0);
  });

  it("drops the queue on dispose", () => {
    const clock = fakeTimers();
    const seen: unknown[] = [];
    const batcher = createHostEventBatcher((events) => seen.push(...events), clock.timers);
    batcher.push(delta(1));
    batcher.dispose();
    clock.fire();
    batcher.flush();
    expect(seen).toEqual([]);
  });

  it("recognises only text and reasoning deltas", () => {
    expect(isStreamDelta(delta(1))).toBe(true);
    expect(isStreamDelta(delta(1, "thinking.delta"))).toBe(true);
    expect(isStreamDelta(settled(1))).toBe(false);
    expect(isStreamDelta({ type: "host.ready" } as HostEvent)).toBe(false);
  });
});
