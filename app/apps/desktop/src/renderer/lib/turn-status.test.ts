import { describe, expect, it } from "vite-plus/test";
import type { TimelineBlock, TimelineItem } from "./timeline.ts";
import {
  arrangeTurnStatus,
  parseTurnStatus,
  TURN_STATUS_TYPE,
  turnFactKey,
  turnTone,
} from "./turn-status.ts";

describe("parseTurnStatus", () => {
  it("keeps known facts in display order, needs-attention first", () => {
    expect(parseTurnStatus({ facts: ["page-ok", "stubs-left", "checks-pass"] })).toEqual({
      facts: ["stubs-left", "checks-pass", "page-ok"],
      tone: "warn",
      files: [],
    });
  });

  it("red wins over a green from the same turn; unknown facts and junk are dropped", () => {
    expect(
      parseTurnStatus({ facts: ["checks-pass", "checks-fail", "made-up", 3], files: ["a.ts", 1] }),
    ).toEqual({ facts: ["checks-fail"], tone: "fail", files: ["a.ts"] });
  });

  it("nothing to show without facts", () => {
    expect(parseTurnStatus(undefined)).toBeUndefined();
    expect(parseTurnStatus({ facts: [] })).toBeUndefined();
    expect(parseTurnStatus({ facts: ["made-up"] })).toBeUndefined();
  });
});

describe("turnTone", () => {
  it("fail, then warn, then ok, else neutral", () => {
    expect(turnTone(["checks-fail", "page-ok"])).toBe("fail");
    expect(turnTone(["tests-changed", "checks-pass"])).toBe("warn");
    // harness's tests-weak (behind testQuality): new tests that check almost nothing
    expect(turnTone(["tests-weak", "checks-pass"])).toBe("warn");
    expect(
      parseTurnStatus({ facts: ["checks-pass", "tests-weak", "tests-changed"] })?.facts,
    ).toEqual(["tests-changed", "tests-weak", "checks-pass"]);
    expect(turnTone(["ran-ok"])).toBe("ok");
    expect(turnTone(["tests-updated"])).toBe("neutral");
    expect(turnTone(["no-checks"])).toBe("neutral");
  });

  it("every fact has its words", () => {
    expect(turnFactKey("checks-fail")).toBe("turnStatus.checks-fail");
  });
});

const user = (id: string): TimelineBlock => ({
  type: "item",
  item: { id, kind: "user", text: "сделай" },
});
const reply = (id: string): TimelineBlock => ({
  type: "item",
  item: { id, kind: "assistant", text: "Готово!" },
});
const process = (id: string): TimelineBlock => ({
  type: "process",
  id,
  items: [{ id: `${id}:t`, kind: "thinking", text: "…" }],
});
const status = (id: string, facts: string[]): TimelineBlock => ({
  type: "item",
  item: {
    id,
    kind: "system",
    text: "",
    title: TURN_STATUS_TYPE,
    extension: true,
    details: { facts },
  } as TimelineItem,
});
const ids = (blocks: TimelineBlock[]) =>
  blocks.map((b) => (b.type === "process" ? `${b.id}${b.checksFailed ? "!" : ""}` : b.item.id));

describe("arrangeTurnStatus", () => {
  it("a red card moves above the model's reply and the turn's header loses «Готово»", () => {
    const blocks = [user("u1"), process("p1"), reply("a1"), status("s1", ["checks-fail"])];
    expect(ids(arrangeTurnStatus(blocks))).toEqual(["u1", "p1!", "s1", "a1"]);
  });

  it("a green card stays under the reply; other turns are untouched", () => {
    const blocks = [
      user("u1"),
      process("p1"),
      reply("a1"),
      status("s1", ["checks-pass"]),
      user("u2"),
      process("p2"),
      reply("a2"),
      status("s2", ["checks-fail"]),
    ];
    expect(ids(arrangeTurnStatus(blocks))).toEqual([
      "u1",
      "p1",
      "a1",
      "s1",
      "u2",
      "p2!",
      "s2",
      "a2",
    ]);
  });

  it("a turn without a reply keeps the card in place (still marks the header)", () => {
    const blocks = [user("u1"), process("p1"), status("s1", ["checks-fail"])];
    expect(ids(arrangeTurnStatus(blocks))).toEqual(["u1", "p1!", "s1"]);
  });
});
