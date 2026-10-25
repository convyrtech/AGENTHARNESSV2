import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { installLogFile, LOG_FILE, PREVIOUS_LOG_FILE } from "./log-file.ts";
import { readZip } from "./read-zip.ts";
import { buildSupportReport, supportReportFileName } from "./report.ts";
import { scrubReportText } from "./scrub.ts";
import { summarizeTurns } from "./turns.ts";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "support-"));
  roots.push(dir);
  return dir;
};

const KEY = "sk-prsloy-1f2e3d4c5b6a7980aabbccdd";
const HOME = "C:\\Users\\Иван Петров";
const ctx = { secrets: [KEY], userName: "Иван Петров", home: HOME };

describe("scrubReportText", () => {
  it("removes the key, key-shaped strings, auth headers and secret fields", () => {
    const text = [
      `key=${KEY}`,
      "other sk-abcdef1234567890",
      "Authorization: Bearer abc.def.ghi-123",
      '{"apiKey":"zzz-secret-value","token": "t0k3n-value"}',
      "GH_TOKEN=ghp_0123456789abcdefghijklmnopqrstuvwxyz",
      "PASSWORD=hunter22",
    ].join("\n");
    const out = scrubReportText(text, ctx);
    for (const leak of [
      KEY,
      "sk-abcdef1234567890",
      "abc.def.ghi-123",
      "zzz-secret-value",
      "t0k3n-value",
      "ghp_0123456789",
      "hunter22",
    ]) {
      expect(out, leak).not.toContain(leak);
    }
  });

  it("masks the user's name in every path spelling and emails", () => {
    const text = [
      `C:\\Users\\Иван Петров\\AppData\\Roaming\\PRSLOY`,
      `"C:\\\\Users\\\\Иван Петров\\\\proj"`,
      "C:/Users/Иван Петров/proj",
      "/c/Users/Иван Петров/proj and the name Иван Петров alone",
      "write to ivan.petrov@example.ru please",
    ].join("\n");
    const out = scrubReportText(text, ctx);
    expect(out).not.toContain("Иван");
    expect(out).toContain("C:\\Users\\<user>\\AppData");
    expect(out).toContain('"C:\\\\Users\\\\<user>\\\\proj"');
    expect(out).toContain("C:/Users/<user>/proj");
    expect(out).toContain("<email>");
    expect(out).not.toContain("example.ru");
  });

  it("leaves ordinary text alone", () => {
    const text = "[prsloy-timing] window 412\nnode v22.19.0 at C:\\Program Files\\x";
    expect(scrubReportText(text, ctx)).toBe(text);
  });
});

describe("summarizeTurns", () => {
  it("keeps metadata only: tools, exit codes, durations, error codes", () => {
    const line = (message: object) => JSON.stringify({ type: "message", message });
    const jsonl = [
      JSON.stringify({ type: "session", id: "x" }),
      line({ role: "user", content: "секретный план в промпте", timestamp: 1000 }),
      line({
        role: "assistant",
        model: "deepseek-v4.1-flash-1017",
        stopReason: "toolUse",
        usage: { output: 42 },
        content: [
          { type: "toolCall", id: "c1", name: "bash", arguments: { command: "cat secret.txt" } },
        ],
        timestamp: 2000,
      }),
      line({
        role: "toolResult",
        toolCallId: "c1",
        toolName: "bash",
        isError: false,
        content: [{ type: "text", text: "[exit 0 · 0,3 с · 9 Б]\nсодержимое файла" }],
        timestamp: 2500,
      }),
      line({
        role: "assistant",
        stopReason: "error",
        errorMessage: "Connection error.",
        timestamp: 3000,
      }),
    ].join("\n");
    const [turn] = summarizeTurns(jsonl);
    expect(turn).toMatchObject({
      models: ["deepseek-v4.1-flash-1017"],
      tools: [{ name: "bash", exitCode: 0, isError: false, durationMs: 500 }],
      stopReasons: ["toolUse", "error"],
      errorCodes: ["network"],
      outputTokens: 42,
      durationMs: 2000,
    });
    const text = JSON.stringify(turn);
    for (const content of ["секретный", "cat secret", "содержимое"]) {
      expect(text).not.toContain(content);
    }
  });

  it("returns the last three turns", () => {
    const jsonl = [1, 2, 3, 4]
      .map((n) =>
        JSON.stringify({
          type: "message",
          message: { role: "user", content: `t${n}`, timestamp: n },
        }),
      )
      .join("\n");
    expect(summarizeTurns(jsonl)).toHaveLength(3);
  });
});

describe("log file", () => {
  it("copies the console to main.log and rotates a big one at start", () => {
    const dir = temp();
    writeFileSync(join(dir, LOG_FILE), "x".repeat(100));
    const lines: string[] = [];
    const target = {
      log: (...a: unknown[]) => void lines.push(a.join(" ")),
      info: (...a: unknown[]) => void lines.push(a.join(" ")),
      warn: (...a: unknown[]) => void lines.push(a.join(" ")),
      error: (...a: unknown[]) => void lines.push(a.join(" ")),
    };
    const log = installLogFile({ dir, maxBytes: 50, target });
    target.log("hello", 1);
    target.warn("careful");
    log.close();
    expect(lines).toEqual(["hello 1", "careful"]);
    expect(readFileSync(join(dir, PREVIOUS_LOG_FILE), "utf8")).toBe("x".repeat(100));
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        const text = readFileSync(join(dir, LOG_FILE), "utf8");
        expect(text).toContain("hello 1");
        expect(text).toContain("WARN careful");
        resolve();
      }, 50),
    );
  });
});

describe("buildSupportReport", () => {
  it("has the expected files and not one line of a planted secret", () => {
    const userData = temp();
    const logDir = join(userData, "logs");
    const sessions = join(userData, "agent", "sessions", "--proj--");
    const crash = join(userData, "Crashpad", "reports");
    for (const d of [logDir, sessions, join(userData, "prsloy"), crash])
      mkdirSync(d, { recursive: true });
    writeFileSync(
      join(logDir, LOG_FILE),
      [
        `[prsloy] agent home ${HOME}\\AppData\\Roaming\\PRSLOY\\agent`,
        `[agent-host:1234] gateway key ${KEY}`,
        "[zeno] update: checking for updates",
        "Authorization: Bearer secret-bearer-token",
      ].join("\n"),
    );
    writeFileSync(
      join(userData, "zeno-desktop.json"),
      JSON.stringify({ lastWorkspace: `${HOME}\\proj` }),
    );
    writeFileSync(
      join(userData, "prsloy", "state.json"),
      JSON.stringify({ baseUrl: "https://gw/v1" }),
    );
    writeFileSync(
      join(sessions, "s.jsonl"),
      JSON.stringify({ type: "message", message: { role: "user", content: KEY, timestamp: 1 } }),
    );
    writeFileSync(join(crash, "clean.dmp"), Buffer.from("MDMP clean dump"));
    writeFileSync(
      join(crash, "leaky.dmp"),
      Buffer.concat([Buffer.from("MDMP "), Buffer.from(KEY, "utf16le")]),
    );

    const { zip, entries } = buildSupportReport({
      now: new Date(2026, 9, 25, 7, 5),
      versions: { app: "0.1.6", home: HOME },
      runtimes: { python: `${HOME}\\AppData\\Roaming\\PRSLOY\\runtimes\\python\\python.exe` },
      userDataPath: userData,
      sessionsDir: join(userData, "agent", "sessions"),
      logDir,
      crashDir: join(userData, "Crashpad"),
      scrub: ctx,
    });
    expect(entries).toEqual(
      expect.arrayContaining([
        "report.json",
        "logs/main.log",
        "logs/updater.log",
        "settings/desktop-prefs.json",
        "settings/prsloy-state.json",
        "crash/clean.dmp",
      ]),
    );
    expect(entries).not.toContain("crash/leaky.dmp");
    const files = readZip(zip);
    const all = Buffer.concat([...files.values()]);
    for (const leak of [KEY, "secret-bearer-token", "Иван", "Петров"]) {
      expect(all.includes(Buffer.from(leak, "utf8")), leak).toBe(false);
      expect(all.includes(Buffer.from(leak, "utf16le")), `${leak} utf16`).toBe(false);
    }
    const report = JSON.parse(files.get("report.json")!.toString("utf8"));
    expect(report.notes.join(" ")).toContain("leaky.dmp");
    expect(files.get("logs/updater.log")!.toString()).toContain("checking for updates");
    expect(supportReportFileName(new Date(2026, 9, 25, 7, 5))).toBe(
      "PRSLOY-отчёт-2026-10-25-0705.zip",
    );
  });
});
