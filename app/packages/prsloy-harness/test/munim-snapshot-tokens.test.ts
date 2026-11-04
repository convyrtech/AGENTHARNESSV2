import { describe, expect, it } from "vite-plus/test";
import { MunimSnapshotTokenStore } from "../src/munim-snapshot-tokens.ts";

describe("MunimSnapshotTokenStore", () => {
  it("binds opaque tokens to the current PID and snapshot", () => {
    const store = new MunimSnapshotTokenStore();
    const snapshot = store.issue(4100, ["e1", "button_2"]);

    expect(snapshot).toBeDefined();
    expect(snapshot!.tokens).toHaveLength(2);
    expect(snapshot!.tokens[0]).toMatch(/^munim_v1\.[0-9a-f-]{36}\.0$/u);
    expect(snapshot!.tokens[1]).toMatch(/^munim_v1\.[0-9a-f-]{36}\.1$/u);
    expect(store.resolve(snapshot!.tokens[0], 4100)).toBe("e1");
    expect(store.resolve(snapshot!.tokens[1], 4100)).toBe("button_2");
    expect(store.resolve(snapshot!.tokens[0], 4101)).toBeUndefined();
  });

  it("rejects a reused backend ID from the previous generation", () => {
    const store = new MunimSnapshotTokenStore();
    const first = store.issue(4100, ["e7"])!;
    const second = store.issue(4100, ["e7"])!;

    expect(second.generationId).not.toBe(first.generationId);
    expect(second.tokens[0]).not.toBe(first.tokens[0]);
    expect(store.resolve(first.tokens[0], 4100)).toBeUndefined();
    expect(store.resolve(second.tokens[0], 4100)).toBe("e7");
  });

  it("invalidates every token explicitly", () => {
    const store = new MunimSnapshotTokenStore();
    const snapshot = store.issue(4100, ["e1", "e2"])!;

    store.invalidate();

    expect(store.resolve(snapshot.tokens[0], 4100)).toBeUndefined();
    expect(store.resolve(snapshot.tokens[1], 4100)).toBeUndefined();
  });

  it("fails closed on duplicate or malformed backend IDs and invalidates old handles", () => {
    const store = new MunimSnapshotTokenStore();
    const initial = store.issue(4100, ["e1"])!;

    expect(store.issue(4100, ["e1", "e1"])).toBeUndefined();
    expect(store.resolve(initial.tokens[0], 4100)).toBeUndefined();
    expect(store.issue(4100, ["e1", "with space"])).toBeUndefined();
    expect(store.issue(4100, ["e1", "\u0000"])).toBeUndefined();
    expect(store.issue(0, ["e1"])).toBeUndefined();
    expect(store.issue(4100, "e1")).toBeUndefined();
  });

  it("replaces snapshots atomically and rejects malformed tokens", () => {
    const store = new MunimSnapshotTokenStore();
    const oldSnapshot = store.issue(4100, ["e1", "e2"])!;
    const newSnapshot = store.issue(5200, ["new_id"])!;

    expect(store.resolve(oldSnapshot.tokens[1], 4100)).toBeUndefined();
    expect(store.resolve(newSnapshot.tokens[0], 4100)).toBeUndefined();
    expect(store.resolve(newSnapshot.tokens[0], 5200)).toBe("new_id");
    expect(store.resolve("e1", 5200)).toBeUndefined();
    expect(store.resolve("munim_v1.not-a-uuid.0", 5200)).toBeUndefined();
    expect(store.resolve("munim_v1.00000000-0000-4000-8000-000000000000.01", 5200)).toBeUndefined();
  });
});
