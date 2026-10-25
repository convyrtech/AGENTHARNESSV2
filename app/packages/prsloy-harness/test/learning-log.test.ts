import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  callSignature,
  configureLearning,
  LEARNING_MAX_BYTES,
  modelFamily,
  projectKey,
  recordEvent,
  turnOutcome,
} from "../src/learning-log.ts";

const root = mkdtempSync(join(tmpdir(), "prsloy-learn-"));
let dir = "";
let n = 0;
beforeEach(() => {
  dir = join(root, `d${n++}`);
  configureLearning({ dir, enabled: true, maxBytes: LEARNING_MAX_BYTES });
});
afterEach(() => configureLearning({ maxBytes: LEARNING_MAX_BYTES }));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const ctx = (cwd = "/home/anna/Сайт кофейни") =>
  ({
    cwd,
    model: { id: "deepseek-v4.1-flash-1017" },
    sessionManager: { getSessionId: () => "s-1" },
  }) as unknown as ExtensionContext;

const lines = () =>
  readFileSync(join(dir, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe("learning log (S0)", () => {
  it("signatures carry no paths and no user text", () => {
    expect(callSignature("bash", { command: "npm test" })).toBe("bash:npm test");
    expect(
      callSignature("bash", { command: "FOO=1 python3 /home/anna/секрет/app.py --port 8080" }),
    ).toBe("bash:python3");
    expect(callSignature("bash", { command: "C:\\Users\\Анна\\tools\\node.exe server.js" })).toBe(
      "bash:node",
    );
    expect(callSignature("bash", { command: "pip install requests" })).toBe("bash:pip install");
    expect(callSignature("bash", { command: "echo 'привет, мир'" })).toBe("bash:echo");
    expect(callSignature("write", { path: "/home/anna/Сайт кофейни/index.HTML" })).toBe(
      "write:.html",
    );
    expect(callSignature("edit", { path: "Makefile" })).toBe("edit:-");
    expect(callSignature("find_ready", { query: "csv parser" })).toBe("find_ready");
  });

  it("model family without provider and build number; project as a hash", () => {
    expect(modelFamily("prsloy/deepseek-v4.1-flash-1017")).toBe("deepseek-v4.1-flash");
    expect(modelFamily("kimi-k3.1-pro")).toBe("kimi-k3.1-pro");
    expect(modelFamily("claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(projectKey("/home/anna/x")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("one JSON line per event: kind, tool, signature, model, project hash — no cwd, no secrets", () => {
    recordEvent(ctx(), {
      kind: "loop.warn",
      tool: "bash",
      sig: callSignature("bash", { command: "npm test" }),
    });
    recordEvent(ctx(), { kind: "gate.red", sig: "gate:sk-live-0123456789abcdefghijklmnop" });
    const [first, second] = lines();
    expect(first).toMatchObject({
      surface: "code",
      session: "s-1",
      model: "deepseek-v4.1-flash",
      profile: "code",
      kind: "loop.warn",
      tool: "bash",
      sig: "bash:npm test",
    });
    expect(first!.project).toBe(projectKey("/home/anna/Сайт кофейни"));
    const raw = readFileSync(join(dir, "events.jsonl"), "utf8");
    expect(raw).not.toContain("anna");
    expect(raw).not.toContain("кофейни");
    expect(raw).not.toContain("sk-live-0123456789");
    expect(String(second!.sig)).toContain("[СКРЫТО");
  });

  it("rotates at the size limit into events.jsonl.1", () => {
    configureLearning({ maxBytes: 600 });
    for (let i = 0; i < 6; i++)
      recordEvent(ctx(), { kind: "repair", tool: "read", sig: "repair:wrapper" });
    expect(existsSync(join(dir, "events.jsonl.1"))).toBe(true);
    expect(readFileSync(join(dir, "events.jsonl"), "utf8").length).toBeLessThanOrEqual(600);
  });

  it("off: nothing is written; a broken folder never throws", () => {
    configureLearning({ enabled: false });
    recordEvent(ctx(), { kind: "leak" });
    expect(existsSync(join(dir, "events.jsonl"))).toBe(false);
    // Папка журнала «внутри» обычного файла — mkdir падает с ENOTDIR.
    const file = join(root, `file-${n}`);
    writeFileSync(file, "x");
    configureLearning({ enabled: true, dir: join(file, "learning") });
    expect(() => recordEvent(ctx(), { kind: "leak" })).not.toThrow();
  });

  it("turn outcome: stop, budget, red, error, green", () => {
    const t = (o: Partial<Parameters<typeof turnOutcome>[0]>) => ({
      calls: 0,
      red: false,
      gaveUp: false,
      budget: false,
      settleOutcome: "completed",
      ...o,
    });
    expect(turnOutcome(t({}), true)).toBe("aborted");
    expect(turnOutcome(t({ budget: true, red: true }), false)).toBe("budget");
    expect(turnOutcome(t({ gaveUp: true }), false)).toBe("red");
    expect(turnOutcome(t({ settleOutcome: "error" }), false)).toBe("error");
    expect(turnOutcome(t({}), false)).toBe("green");
  });
});
