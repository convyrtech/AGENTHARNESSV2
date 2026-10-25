/**
 * «The user left this chat» from every way the supervisor changes the foreground session file
 * (new chat, switch, start, snapshot): the memory extractor runs on it (research/24 §3.3).
 */
import { afterEach, describe, expect, it } from "vite-plus/test";
import { onSessionLeft, resetSessionTracking, trackSessionFile } from "./session-left.ts";

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  resetSessionTracking();
});

describe("session left", () => {
  it("a move to another file leaves the previous one; «no file» in between is not a second leave", () => {
    const left: string[] = [];
    stops.push(onSessionLeft((file) => void left.push(file)));
    expect(trackSessionFile("/s/a.jsonl")).toBe("/s/a.jsonl");
    trackSessionFile("/s/a.jsonl");
    // «Новый чат»: no file until the first message, then the new one.
    expect(trackSessionFile(undefined)).toBeUndefined();
    trackSessionFile("/s/b.jsonl");
    // Back to the first chat from the list.
    trackSessionFile("/s/a.jsonl");
    expect(left).toEqual(["/s/a.jsonl", "/s/b.jsonl"]);
  });
});
