import { describe, expect, it } from "vite-plus/test";
import { isModelFailure } from "./system-notices.ts";
import {
  appendMonotonicText,
  applyRuntimeEventToLiveStream,
  assertLiveStreamTextMonotonic,
  emptyLiveStream,
  liveStreamNotCoveredByHistory,
  retractOptimisticUserMessage,
} from "./live-stream.ts";

describe("appendMonotonicText", () => {
  it("appends incremental chunks", () => {
    expect(appendMonotonicText("", "Hel")).toBe("Hel");
    expect(appendMonotonicText("Hel", "lo")).toBe("Hello");
  });

  it("keeps a delta that repeats the tail (live acceptance: «800» + «0» showed «800»)", () => {
    expect(appendMonotonicText("800", "0")).toBe("8000");
    expect(appendMonotonicText("Hello", "lo")).toBe("Hellolo");
    expect(appendMonotonicText("ab", "bc")).toBe("abbc");
    expect(appendMonotonicText("а", "а")).toBe("аа");
  });
});

describe("streamed text never loses characters", () => {
  function stream(deltas: string[], type: "message.delta" | "thinking.delta" = "message.delta") {
    let state = emptyLiveStream();
    deltas.forEach((delta, i) => {
      state = applyRuntimeEventToLiveStream(state, { type, delta }, [], { sequence: i + 1 });
    });
    const item = state.items[0];
    return item && "text" in item ? item.text : undefined;
  }

  it.each([
    [["800", "0"], "8000"],
    [["Итого: 1", "0", "0", "0 ₽"], "Итого: 1000 ₽"],
    [["100", "0 ₽"], "1000 ₽"],
    [["а", "а", "а", "а"], "аааа"],
    [["ha", "ha", "ha"], "hahaha"],
    [["Hello wor", "world"], "Hello worworld"],
  ])("%j → %s", (deltas, expected) => {
    expect(stream(deltas)).toBe(expected);
    expect(stream(deltas, "thinking.delta")).toBe(expected);
  });

  it("still drops a redelivered event by its host sequence", () => {
    let state = emptyLiveStream();
    state = applyRuntimeEventToLiveStream(state, { type: "message.delta", delta: "10" }, [], {
      sequence: 1,
    });
    state = applyRuntimeEventToLiveStream(state, { type: "message.delta", delta: "0" }, [], {
      sequence: 2,
    });
    state = applyRuntimeEventToLiveStream(state, { type: "message.delta", delta: "0" }, [], {
      sequence: 2,
    });
    const item = state.items[0];
    expect(item && "text" in item ? item.text : undefined).toBe("100");
  });
});

describe("message end reconciles with pi's stored text", () => {
  type Ev = Parameters<typeof applyRuntimeEventToLiveStream>[1];
  function run(events: Ev[]) {
    let state = emptyLiveStream();
    events.forEach((event, i) => {
      state = applyRuntimeEventToLiveStream(state, event, [], { sequence: i + 1 });
    });
    return state.items.map((item) => [item.kind, "text" in item ? item.text : ""]);
  }

  it("replaces streamed text that lost or doubled a delta", () => {
    expect(
      run([
        { type: "thinking.delta", delta: "Let me" },
        { type: "message.delta", delta: "Итого: 100 ₽" },
        {
          type: "message.completed",
          reason: "stop",
          text: "Итого: 1000 ₽",
          thinking: "Let me look",
        },
      ]),
    ).toEqual([
      ["thinking", "Let me look"],
      ["assistant", "Итого: 1000 ₽"],
    ]);
  });

  it("keeps the row (same id) and changes nothing when the text matches", () => {
    let state = emptyLiveStream();
    state = applyRuntimeEventToLiveStream(state, { type: "message.delta", delta: "Готово." }, [], {
      sequence: 1,
    });
    const before = state.items;
    state = applyRuntimeEventToLiveStream(
      state,
      { type: "message.completed", reason: "stop", text: "Готово." },
      [],
      { sequence: 2 },
    );
    expect(state.items).toBe(before);
  });

  it("adds a reply whose deltas never arrived", () => {
    expect(
      run([
        { type: "user.message", content: "Привет" },
        { type: "message.completed", reason: "stop", text: "Здравствуйте!" },
      ]),
    ).toEqual([
      ["user", "Привет"],
      ["assistant", "Здравствуйте!"],
    ]);
  });

  it("leaves earlier messages, older core events and tool-only replies alone", () => {
    expect(
      run([
        { type: "message.delta", delta: "Первый" },
        { type: "message.completed", reason: "toolUse", text: "Первый" },
        { type: "tool.started", toolCallId: "t1", toolName: "bash", args: {} },
        { type: "message.completed", reason: "toolUse", text: "" },
        { type: "message.delta", delta: "Второй" },
        { type: "message.completed", reason: "stop" },
      ]).filter(([kind]) => kind !== "tool"),
    ).toEqual([
      ["assistant", "Первый"],
      ["assistant", "Второй"],
    ]);
  });
});

describe("message end never rewrites an earlier message", () => {
  it("leaves a row shared with the previous message as streamed", () => {
    let state = emptyLiveStream();
    const events: Parameters<typeof applyRuntimeEventToLiveStream>[1][] = [
      { type: "message.delta", delta: "Первый. " },
      { type: "message.completed", reason: "stop", text: "Первый. " },
      { type: "message.delta", delta: "Второй" },
      { type: "message.completed", reason: "stop", text: "Второй!" },
    ];
    events.forEach((event, i) => {
      state = applyRuntimeEventToLiveStream(state, event, [], { sequence: i + 1 });
    });
    expect(state.items.map((item) => ("text" in item ? item.text : ""))).toEqual([
      "Первый. Второй",
    ]);
  });
});

describe("a model failure becomes the failure card", () => {
  // The proxy's mid-stream drop (code prsloy_stream_interrupted) reaches pi's errorMessage as
  // «Связь с моделью оборвалась»; it must look exactly like a network drop.
  it.each([
    ["Связь с моделью оборвалась", "unknown"],
    ["Connection error.", "network"],
  ] as const)("%s (%s)", (message, code) => {
    let state = emptyLiveStream();
    state = applyRuntimeEventToLiveStream(state, { type: "message.delta", delta: "Нача" }, [], {
      sequence: 1,
    });
    state = applyRuntimeEventToLiveStream(
      state,
      { type: "message.failed", reason: "error", message, code },
      [],
      { sequence: 2 },
    );
    const failure = state.items.at(-1);
    expect(failure?.kind).toBe("system");
    expect(failure && isModelFailure(failure as { title?: string; tone?: string })).toBe(true);
    expect(failure && "code" in failure ? failure.code : undefined).toBe(code);
  });
});

describe("live stream (append-only)", () => {
  it("stamps the settle time on the turn's final reply, once", () => {
    let state = emptyLiveStream();
    state = applyRuntimeEventToLiveStream(state, { type: "message.delta", delta: "Готово" }, [], {
      sequence: 1,
    });
    state = applyRuntimeEventToLiveStream(state, { type: "agent.settled" }, [], { sequence: 2 });
    const reply = state.items.find((item) => item.kind === "assistant");
    const endedAt = reply?.kind === "assistant" ? reply.endedAt : undefined;
    expect(endedAt).toBeTruthy();
    state = applyRuntimeEventToLiveStream(state, { type: "agent.settled" }, [], { sequence: 3 });
    const again = state.items.find((item) => item.kind === "assistant");
    expect(again?.kind === "assistant" ? again.endedAt : undefined).toBe(endedAt);
  });

  it("only grows assistant text under many deltas", () => {
    let state = emptyLiveStream();
    for (let i = 0; i < 300; i++) {
      state = applyRuntimeEventToLiveStream(state, { type: "message.delta", delta: `t${i} ` }, [], {
        sequence: i + 1,
      });
    }
    const assistant = state.items.find((item) => item.kind === "assistant");
    expect(assistant?.kind === "assistant" && assistant.text.startsWith("t0 ")).toBe(true);
    expect(assistant?.kind === "assistant" && assistant.text.includes("t299 ")).toBe(true);
    expect(
      assistant?.kind === "assistant" && assistant.text.split(/\s+/).filter(Boolean),
    ).toHaveLength(300);
  });

  it("dedupes by host sequence so redelivery does not double-append", () => {
    let state = emptyLiveStream();
    state = applyRuntimeEventToLiveStream(state, { type: "message.delta", delta: "Hello" }, [], {
      sequence: 10,
    });
    state = applyRuntimeEventToLiveStream(state, { type: "message.delta", delta: "Hello" }, [], {
      sequence: 10,
    });
    state = applyRuntimeEventToLiveStream(state, { type: "message.delta", delta: " world" }, [], {
      sequence: 11,
    });
    const assistant = state.items.find((item) => item.kind === "assistant");
    expect(assistant?.kind === "assistant" && assistant.text).toBe("Hello world");
  });

  it("keeps event order: thinking → assistant → tool → assistant", () => {
    let state = emptyLiveStream();
    state = applyRuntimeEventToLiveStream(state, { type: "thinking.delta", delta: "plan" }, [], {
      sequence: 1,
    });
    state = applyRuntimeEventToLiveStream(state, { type: "message.delta", delta: "Hi" }, [], {
      sequence: 2,
    });
    state = applyRuntimeEventToLiveStream(
      state,
      { type: "tool.started", toolCallId: "1", toolName: "bash", args: { command: "ls" } },
      [],
      { sequence: 3 },
    );
    state = applyRuntimeEventToLiveStream(
      state,
      {
        type: "tool.completed",
        toolCallId: "1",
        toolName: "bash",
        output: "ok",
        isError: false,
      },
      [],
      { sequence: 4 },
    );
    state = applyRuntimeEventToLiveStream(state, { type: "message.delta", delta: "Done" }, [], {
      sequence: 5,
    });

    expect(state.items.map((item) => item.kind)).toEqual([
      "thinking",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(state.items[1]).toMatchObject({ kind: "assistant", text: "Hi" });
    expect(state.items[3]).toMatchObject({ kind: "assistant", text: "Done" });
    expect(state.items[2]).toMatchObject({ kind: "tool", status: "completed" });
  });

  it("never shortens an existing assistant buffer across a long stream", () => {
    let state = emptyLiveStream();
    let prev = state;
    for (let i = 0; i < 200; i++) {
      state = applyRuntimeEventToLiveStream(state, { type: "message.delta", delta: `x${i}` }, [], {
        sequence: i + 1,
      });
      expect(assertLiveStreamTextMonotonic(prev, state)).toBe(true);
      prev = state;
    }
    const assistant = state.items.find((item) => item.kind === "assistant");
    expect(assistant?.kind === "assistant" && assistant.text.startsWith("x0")).toBe(true);
    expect(assistant?.kind === "assistant" && assistant.text.includes("x199")).toBe(true);
  });

  it("keeps attachment chips on optimistic user rows and merges host echo paths", () => {
    let state = emptyLiveStream();
    const prompts = ["Inspect these"];
    // Optimistic (or full) payload with attached-paths — same shape as sendPrompt.
    state = applyRuntimeEventToLiveStream(
      state,
      {
        type: "user.message",
        content:
          "Inspect these\n\n<attached-paths>\n  <path>/tmp/a.png</path>\n  <path>/tmp/note.md</path>\n</attached-paths>",
      },
      prompts,
      { sequence: 1 },
    );
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      kind: "user",
      text: "Inspect these",
      attachments: ["/tmp/a.png", "/tmp/note.md"],
    });

    // Host re-echo with same text + paths must not drop chips or double the row.
    state = applyRuntimeEventToLiveStream(
      state,
      {
        type: "user.message",
        content:
          "Inspect these\n\n<attached-paths>\n  <path>/tmp/a.png</path>\n  <path>/tmp/note.md</path>\n  <path>/tmp/extra.txt</path>\n</attached-paths>",
      },
      prompts,
      { sequence: 2 },
    );
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      kind: "user",
      text: "Inspect these",
      attachments: ["/tmp/a.png", "/tmp/note.md", "/tmp/extra.txt"],
    });
  });

  it("fills attachments when optimistic row had text only", () => {
    let state = emptyLiveStream();
    const prompts = ["Look"];
    state = applyRuntimeEventToLiveStream(
      state,
      { type: "user.message", content: "Look" },
      prompts,
      { sequence: 1 },
    );
    expect(state.items[0]).toMatchObject({ kind: "user", text: "Look" });
    expect(
      state.items[0]?.kind === "user" ? state.items[0].attachments : undefined,
    ).toBeUndefined();

    state = applyRuntimeEventToLiveStream(
      state,
      {
        type: "user.message",
        content: "Look\n\n<attached-paths>\n  <path>/tmp/photo.webp</path>\n</attached-paths>",
      },
      prompts,
      { sequence: 2 },
    );
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      kind: "user",
      text: "Look",
      attachments: ["/tmp/photo.webp"],
    });
  });

  it("retracts a ghost user row so queued steer does not split the assistant", () => {
    let state = emptyLiveStream();
    state = applyRuntimeEventToLiveStream(
      state,
      { type: "user.message", content: "first" },
      ["first"],
      { sequence: 1 },
    );
    state = applyRuntimeEventToLiveStream(
      state,
      { type: "message.delta", delta: "Working on it" },
      ["first"],
      { sequence: 2 },
    );
    // Bug path: optimistic user for a mid-turn queue lands between assistant chunks.
    state = applyRuntimeEventToLiveStream(
      state,
      { type: "user.message", content: "steer please" },
      ["first", "steer please"],
      { sequence: 3, optimistic: true },
    );
    expect(state.items.map((item) => item.kind)).toEqual(["user", "assistant", "user"]);
    expect(state.promptIndex).toBe(1);

    state = retractOptimisticUserMessage(state, "steer please");
    expect(state.items.map((item) => item.kind)).toEqual(["user", "assistant"]);
    expect(state.promptIndex).toBe(1);

    // Further assistant deltas rejoin the open bubble instead of starting a new one.
    state = applyRuntimeEventToLiveStream(state, { type: "message.delta", delta: "…" }, ["first"], {
      sequence: 4,
    });
    expect(state.items.map((item) => item.kind)).toEqual(["user", "assistant"]);
    expect(state.items[1]).toMatchObject({ kind: "assistant", text: "Working on it…" });
  });

  it("replaces an expanded slash/skill host echo with the optimistic original text", () => {
    let state = emptyLiveStream();
    const prompts = ["/skill:officecli"];
    // Optimistic preview shows the exact typed command.
    state = applyRuntimeEventToLiveStream(
      state,
      { type: "user.message", content: "/skill:officecli" },
      prompts,
      { optimistic: true },
    );
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ kind: "user", text: "/skill:officecli" });
    expect(state.promptIndex).toBe(0);

    // Host echoes the EXPANDED <skill> block — must dedupe against the original
    // and never surface a second bubble carrying the full skill body.
    state = applyRuntimeEventToLiveStream(
      state,
      {
        type: "user.message",
        content:
          '<skill name="officecli" location="/x/officecli">\nReferences are relative to baseDir.\n\nYou can do X.\n</skill>',
      },
      prompts,
      { sequence: 1 },
    );
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ kind: "user", text: "/skill:officecli" });
    expect(state.promptIndex).toBe(1);
  });

  it("ignores retract when the display text is not present", () => {
    let state = emptyLiveStream();
    state = applyRuntimeEventToLiveStream(
      state,
      { type: "user.message", content: "keep me" },
      ["keep me"],
      { sequence: 1 },
    );
    const next = retractOptimisticUserMessage(state, "missing");
    expect(next).toEqual(state);
  });
});

describe("liveStreamNotCoveredByHistory", () => {
  it("drops user/assistant rows already present in history and keeps open tools", () => {
    let state = emptyLiveStream();
    state = applyRuntimeEventToLiveStream(state, { type: "user.message", content: "hi" }, ["hi"], {
      sequence: 1,
    });
    state = applyRuntimeEventToLiveStream(state, { type: "message.delta", delta: "hello" }, [], {
      sequence: 2,
    });
    state = applyRuntimeEventToLiveStream(
      state,
      { type: "tool.started", toolCallId: "t1", toolName: "bash", args: {} },
      [],
      { sequence: 3 },
    );
    const next = liveStreamNotCoveredByHistory(state, [
      { role: "user", text: "hi" },
      { role: "assistant", text: "hello" },
    ]);
    expect(next.items.some((item) => item.kind === "user" || item.kind === "assistant")).toBe(
      false,
    );
    expect(next.items.some((item) => item.kind === "tool" && item.status === "running")).toBe(true);
  });

  it("keeps live assistant text when history is a stale prefix (extra tokens)", () => {
    let state = emptyLiveStream();
    state = applyRuntimeEventToLiveStream(
      state,
      { type: "message.delta", delta: "Hello world" },
      [],
      {
        sequence: 1,
      },
    );
    // History flushed mid-stream only has the head of the reply; the live stream
    // holds the full text. It must not be dropped or the tail is lost.
    const next = liveStreamNotCoveredByHistory(state, [{ role: "assistant", text: "Hello" }]);
    expect(
      next.items.some((item) => item.kind === "assistant" && item.text === "Hello world"),
    ).toBe(true);
  });
});
