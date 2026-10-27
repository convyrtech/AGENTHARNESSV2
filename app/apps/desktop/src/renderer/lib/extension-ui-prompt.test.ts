import { describe, expect, it, beforeEach } from "vite-plus/test";
import { IPC_PROTOCOL_VERSION } from "@zeno/contracts";
import {
  cancelExtensionUiDialogs,
  cancelExtensionUiDialogsForCrash,
  cancelExtensionUiDialogsForRuntime,
  getPendingExtensionUiDialog,
  getQueuedExtensionUiDialogs,
  isExtensionUiDialogMethod,
  pendingExtensionUiDialogCount,
  settleExtensionUiDialogById,
  parseConfirmArgs,
  parseInputArgs,
  parseSelectArgs,
  promptExtensionUiDialog,
  settleExtensionUiDialog,
  subscribeExtensionUiDialog,
  type ExtensionUiDialogRequest,
} from "./extension-ui-prompt.ts";

function selectRequest(options: string[]): ExtensionUiDialogRequest {
  return {
    protocolVersion: IPC_PROTOCOL_VERSION,
    type: "extensionUi.request",
    runtimeId: "rt-1",
    requestId: "req-1",
    method: "select",
    args: { title: "Pick one", options },
  };
}

describe("parseSelectArgs", () => {
  it("extracts title and string options", () => {
    expect(parseSelectArgs({ title: "Choose", options: ["a", "b"] })).toEqual({
      title: "Choose",
      options: ["a", "b"],
    });
  });

  it("preserves ask-user-question style option lines (index + label + description)", () => {
    // Mirrors @juicesharp/rpiv-ask-user-question rpc-fallback formatOptionLine.
    const options = [
      "1. TypeScript — Prefer typed source",
      "2. JavaScript — Keep the current stack",
      "3. Type something.",
    ];
    const parsed = parseSelectArgs({
      title: "[Stack] Which language?\n\n--- 1. TypeScript preview ---\n```ts\nconst x = 1\n```",
      options,
    });
    expect(parsed.title).toContain("Which language?");
    expect(parsed.options).toEqual(options);
    expect(parsed.options).toHaveLength(3);
  });

  it("keeps every option when the host emits the portable bridge payload", () => {
    // Portable bridge: dialog("select", { title, options: values })
    const payload = { title: "Pick a path", options: ["alpha", "beta", "gamma"] };
    expect(parseSelectArgs(payload).options).toEqual(["alpha", "beta", "gamma"]);
  });

  it("drops non-string options so they are not silently empty", () => {
    expect(
      parseSelectArgs({ title: "Q", options: ["ok", 1, null, { label: "x" }, "two"] }),
    ).toEqual({
      title: "Q",
      options: ["ok", "two"],
    });
  });

  it("defaults when args are missing or malformed", () => {
    expect(parseSelectArgs(undefined)).toEqual({ title: "Select", options: [] });
    expect(parseSelectArgs({ options: "not-array" })).toEqual({ title: "Select", options: [] });
    expect(parseSelectArgs({ title: 42, options: [] })).toEqual({ title: "Select", options: [] });
  });
});

describe("parseConfirmArgs / parseInputArgs", () => {
  it("parses confirm fields", () => {
    expect(parseConfirmArgs({ title: "Sure?", message: "Really" })).toEqual({
      title: "Sure?",
      message: "Really",
    });
  });

  it("parses input placeholder and editor prefill", () => {
    expect(parseInputArgs({ title: "Name", placeholder: "hint" }, "input")).toEqual({
      title: "Name",
      initial: "hint",
    });
    expect(parseInputArgs({ title: "Edit", prefill: "body" }, "editor")).toEqual({
      title: "Edit",
      initial: "body",
    });
  });
});

describe("promptExtensionUiDialog bridge", () => {
  beforeEach(() => {
    // Drain any leftover pending from a previous test.
    cancelExtensionUiDialogs();
  });

  it("exposes the pending request to subscribers and settles with the selected value", async () => {
    const seen: unknown[] = [];
    const unsub = subscribeExtensionUiDialog(() => {
      seen.push(getPendingExtensionUiDialog()?.args);
    });

    const resultPromise = promptExtensionUiDialog(
      selectRequest(["1. Alpha — first", "2. Beta — second"]),
    );
    expect(getPendingExtensionUiDialog()?.method).toBe("select");
    const parsed = parseSelectArgs(getPendingExtensionUiDialog()?.args);
    expect(parsed.options).toEqual(["1. Alpha — first", "2. Beta — second"]);

    settleExtensionUiDialog({ ok: true, value: "2. Beta — second" });
    await expect(resultPromise).resolves.toEqual({ ok: true, value: "2. Beta — second" });
    expect(getPendingExtensionUiDialog()).toBeNull();
    expect(seen.length).toBeGreaterThanOrEqual(1);
    unsub();
  });

  it("returns cancel for select without inventing a value outside options", async () => {
    const resultPromise = promptExtensionUiDialog(selectRequest(["only-one"]));
    settleExtensionUiDialog({ ok: false, value: undefined });
    await expect(resultPromise).resolves.toEqual({ ok: false, value: undefined });
  });

  it("queues a second question instead of cancelling the first (#83)", async () => {
    const first = promptExtensionUiDialog(selectRequest(["a"]));
    const second = promptExtensionUiDialog({
      ...selectRequest(["b"]),
      requestId: "req-2",
    });
    // The first question stays on screen; the second waits its turn.
    expect(getPendingExtensionUiDialog()?.requestId).toBe("req-1");
    expect(getQueuedExtensionUiDialogs().map((item) => item.requestId)).toEqual(["req-2"]);
    expect(pendingExtensionUiDialogCount()).toBe(2);

    settleExtensionUiDialog({ ok: true, value: "a" });
    await expect(first).resolves.toEqual({ ok: true, value: "a" });
    // Now the queued one is on screen, not lost.
    expect(getPendingExtensionUiDialog()?.requestId).toBe("req-2");
    settleExtensionUiDialog({ ok: true, value: "b" });
    await expect(second).resolves.toEqual({ ok: true, value: "b" });
    expect(pendingExtensionUiDialogCount()).toBe(0);
  });

  it("shows a question asked twice once, and answers both asks", async () => {
    // The host re-emits on reconnect and an extension's session_start can run twice.
    const first = promptExtensionUiDialog(selectRequest(["a"]));
    const again = promptExtensionUiDialog({ ...selectRequest(["a"]), requestId: "req-1b" });
    expect(pendingExtensionUiDialogCount()).toBe(1);
    settleExtensionUiDialog({ ok: true, value: "a" });
    await expect(first).resolves.toEqual({ ok: true, value: "a" });
    await expect(again).resolves.toEqual({ ok: true, value: "a" });
    expect(getPendingExtensionUiDialog()).toBeNull();
  });

  it("keeps a different question from the same chat in the queue", async () => {
    const first = promptExtensionUiDialog(selectRequest(["a"]));
    const second = promptExtensionUiDialog({
      ...selectRequest(["b"]),
      requestId: "req-2",
    });
    expect(pendingExtensionUiDialogCount()).toBe(2);
    settleExtensionUiDialog({ ok: true, value: "a" });
    await expect(first).resolves.toEqual({ ok: true, value: "a" });
    settleExtensionUiDialog({ ok: true, value: "b" });
    await expect(second).resolves.toEqual({ ok: true, value: "b" });
  });

  it("settles one request by id without touching the others", async () => {
    const first = promptExtensionUiDialog(selectRequest(["a"]));
    const second = promptExtensionUiDialog({ ...selectRequest(["b"]), requestId: "req-2" });
    expect(settleExtensionUiDialogById("req-2", { ok: true, value: "b" })).toBe(true);
    await expect(second).resolves.toEqual({ ok: true, value: "b" });
    expect(getPendingExtensionUiDialog()?.requestId).toBe("req-1");
    settleExtensionUiDialog({ ok: false, value: undefined });
    await expect(first).resolves.toEqual({ ok: false, value: undefined });
  });

  it("cancels every open question when the agent is stopped", async () => {
    const first = promptExtensionUiDialog(selectRequest(["a"]));
    const second = promptExtensionUiDialog({ ...selectRequest(["b"]), requestId: "req-2" });
    expect(cancelExtensionUiDialogs()).toBe(2);
    await expect(first).resolves.toEqual({ ok: false, value: undefined });
    await expect(second).resolves.toEqual({ ok: false, value: undefined });
    expect(getPendingExtensionUiDialog()).toBeNull();
  });

  it("cancels only the questions of a crashed runtime", async () => {
    const mine = promptExtensionUiDialog(selectRequest(["a"]));
    const other = promptExtensionUiDialog({
      ...selectRequest(["b"]),
      requestId: "req-2",
      runtimeId: "rt-2",
    });
    expect(cancelExtensionUiDialogsForRuntime("rt-1")).toBe(1);
    await expect(mine).resolves.toEqual({ ok: false, value: undefined });
    // A question from the other chat is still answerable.
    expect(getPendingExtensionUiDialog()?.runtimeId).toBe("rt-2");
    settleExtensionUiDialog({ ok: true, value: "b" });
    await expect(other).resolves.toEqual({ ok: true, value: "b" });
  });

  it("closes only the crashed host's question and leaves parked chats answerable (#83)", async () => {
    // Two chats ask at the same time; the foreground host then dies.
    const crashed = promptExtensionUiDialog(selectRequest(["a"]));
    const parked = promptExtensionUiDialog({
      ...selectRequest(["b"]),
      runtimeId: "rt-2",
      requestId: "req-2",
    });
    expect(pendingExtensionUiDialogCount()).toBe(2);

    expect(cancelExtensionUiDialogsForCrash("rt-1")).toBe(1);
    await expect(crashed).resolves.toEqual({ ok: false, value: undefined });
    // The parked chat still has its host: its question must stay on screen.
    expect(getPendingExtensionUiDialog()?.runtimeId).toBe("rt-2");
    settleExtensionUiDialog({ ok: true, value: "b" });
    await expect(parked).resolves.toEqual({ ok: true, value: "b" });
  });

  it("cancels everything on a crash with no runtime id to blame (#83)", async () => {
    const first = promptExtensionUiDialog(selectRequest(["a"]));
    const second = promptExtensionUiDialog({
      ...selectRequest(["b"]),
      runtimeId: "rt-2",
      requestId: "req-2",
    });
    expect(cancelExtensionUiDialogsForCrash(undefined)).toBe(2);
    await expect(first).resolves.toEqual({ ok: false, value: undefined });
    await expect(second).resolves.toEqual({ ok: false, value: undefined });
    expect(pendingExtensionUiDialogCount()).toBe(0);
  });

  it("exposes all options on the pending select request for the host UI", async () => {
    const options = ["1. Red", "2. Green", "3. Blue"];
    const pending = promptExtensionUiDialog(selectRequest(options));
    const request = getPendingExtensionUiDialog();
    expect(request?.method).toBe("select");
    // Host renders from these args — empty/missing options is the #32 failure mode.
    expect(parseSelectArgs(request?.args).options).toEqual(options);
    settleExtensionUiDialog({ ok: true, value: options[0] });
    await pending;
  });
});

describe("isExtensionUiDialogMethod", () => {
  it("accepts dialog methods only", () => {
    expect(isExtensionUiDialogMethod("select")).toBe(true);
    expect(isExtensionUiDialogMethod("notify")).toBe(false);
  });
});
