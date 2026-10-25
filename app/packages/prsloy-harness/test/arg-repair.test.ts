import { describe, expect, it } from "vite-plus/test";
import {
  callShape,
  closeUnterminated,
  fixWindowsPathsInCommand,
  parseArgumentsText,
  repairToolCall,
  type ToolCallPart,
  validationHint,
} from "../src/arg-repair.ts";

const READ = {
  type: "object",
  properties: {
    path: { type: "string" },
    offset: { type: "number" },
    limit: { type: "number" },
  },
  required: ["path"],
};
const BASH = {
  type: "object",
  properties: { command: { type: "string" }, timeout: { type: "number" } },
  required: ["command"],
};

const call = (name: string, args: unknown, raw?: string): ToolCallPart => ({
  type: "toolCall",
  id: "c1",
  name,
  arguments: raw === undefined ? args : {},
  ...(raw === undefined
    ? {}
    : { argumentsError: `Tool arguments must be a JSON object\n\nReceived arguments:\n${raw}` }),
});

describe("argument repair (ADR-3)", () => {
  it("JSON as a string instead of an object", () => {
    const r = repairToolCall(
      call("read", undefined, JSON.stringify(JSON.stringify({ path: "a.txt" }))),
      READ,
    );
    expect(r?.call.arguments).toEqual({ path: "a.txt" });
    expect(r?.call.argumentsError).toBeUndefined();
    expect(r?.kinds).toEqual(["json-string"]);
    // Строкой в самом arguments (если провайдер так отдал).
    expect(repairToolCall(call("read", '{"path":"b.txt"}'), READ)?.call.arguments).toEqual({
      path: "b.txt",
    });
  });

  it("a number as a string", () => {
    const r = repairToolCall(call("read", { path: "a.txt", offset: "10", limit: " 5 " }), READ);
    expect(r?.call.arguments).toEqual({ path: "a.txt", offset: 10, limit: 5 });
    expect(repairToolCall(call("read", { path: "a.txt", offset: "десять" }), READ)).toBeUndefined();
  });

  it("an extra wrapper {arguments: {...}} or {name, arguments}", () => {
    expect(
      repairToolCall(call("bash", { arguments: { command: "ls" } }), BASH)?.call.arguments,
    ).toEqual({
      command: "ls",
    });
    const named = repairToolCall(
      call("bash", { name: "bash", arguments: '{"command":"pwd"}' }),
      BASH,
    );
    expect(named?.call.arguments).toEqual({ command: "pwd" });
    expect(named?.kinds).toEqual(["wrapper"]);
    // Свойство с таким именем есть в схеме — не обёртка.
    const own = { type: "object", properties: { input: { type: "string" } } };
    expect(repairToolCall(call("x", { input: "текст" }), own)).toBeUndefined();
  });

  it("unclosed quotes and brackets at the end", () => {
    expect(closeUnterminated('{"path": "a.txt')).toBe('{"path": "a.txt"}');
    expect(closeUnterminated('{"a": [1, 2')).toBe('{"a": [1, 2]}');
    expect(closeUnterminated('{"a": "x\\"y')).toBe('{"a": "x\\"y"}');
    const r = repairToolCall(call("bash", undefined, '{"command": "echo hi'), BASH);
    expect(r?.call.arguments).toEqual({ command: "echo hi" });
    expect(r?.kinds).toEqual(["unclosed"]);
    expect(parseArgumentsText("совсем не json")).toBeUndefined();
    expect(repairToolCall(call("bash", undefined, "совсем не json"), BASH)).toBeUndefined();
  });

  it("Windows: backslash paths in path arguments and C:\\ outside quotes in Git Bash", () => {
    const r = repairToolCall(
      call("read", { path: "C:\\Users\\anna\\site\\index.html" }),
      READ,
      "win32",
    );
    expect(r?.call.arguments).toEqual({ path: "C:/Users/anna/site/index.html" });
    expect(r?.kinds).toEqual(["windows-path"]);
    // На Linux обратный слэш в имени файла законен — не трогаем.
    expect(repairToolCall(call("read", { path: "a\\b.txt" }), READ, "linux")).toBeUndefined();
    expect(fixWindowsPathsInCommand("cd C:\\Users\\anna\\site && ls")).toBe(
      "cd C:/Users/anna/site && ls",
    );
    // В кавычках Git Bash сам понимает путь: не трогаем.
    expect(fixWindowsPathsInCommand("cd 'C:\\Users\\anna' && echo \"D:\\x\"")).toBe(
      "cd 'C:\\Users\\anna' && echo \"D:\\x\"",
    );
    expect(fixWindowsPathsInCommand("printf 'a\\nb'")).toBe("printf 'a\\nb'");
    const cmd = repairToolCall(call("bash", { command: "python C:\\work\\run.py" }), BASH, "win32");
    expect(cmd?.call.arguments).toEqual({ command: "python C:/work/run.py" });
  });

  it("a good call is left alone", () => {
    expect(
      repairToolCall(call("read", { path: "a.txt", offset: 3 }), READ, "win32"),
    ).toBeUndefined();
  });

  it("the hint shows the right shape", () => {
    expect(callShape("read", READ)).toBe('read {"path": "<строка>"}');
    expect(callShape("bash", BASH)).toBe('bash {"command": "<строка>"}');
    expect(validationHint("read", READ)).toContain(
      'правильная форма вызова — read {"path": "<строка>"}',
    );
  });
});

describe("count-tool-errors.mts (for the A/B sessions)", () => {
  it("counts schema and JSON errors and how many the harness repairs", async () => {
    const { spawnSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const script = fileURLToPath(new URL("../scripts/count-tool-errors.mts", import.meta.url));
    const fixture = fileURLToPath(new URL("./fixtures/sessions", import.meta.url));
    const out = spawnSync(process.execPath, [script, fixture], { encoding: "utf8" });
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("| broken-args.jsonl | 3 | 2 | 1 | 2 |");
    expect(out.stdout).toContain(
      "ошибок проверки аргументов 3 (схема 2, битый JSON 1); из них чинит харнесс (без схемы) 2",
    );
  });
});
