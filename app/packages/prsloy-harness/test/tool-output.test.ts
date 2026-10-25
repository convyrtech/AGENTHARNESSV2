import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { resolveOptions } from "../src/options.ts";
import { headTail } from "../src/text.ts";
import { installToolOutput } from "../src/tool-output.ts";
import { MockPi } from "./mock-pi.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "prsloy-out-"));
  dirs.push(dir);
  const pi = new MockPi(dir);
  installToolOutput(pi.api, resolveOptions({ outputDir: dir }));
  return { pi, dir };
}

const lines = (n: number, prefix = "line") =>
  Array.from({ length: n }, (_, i) => `${prefix} ${i + 1} ${"x".repeat(40)}`).join("\n");

describe("tool output", () => {
  it("prepends exit code, time and size to every bash result", async () => {
    const { pi } = await setup();
    await pi.toolCall("bash", { command: "echo hi" }, "b1");
    const result = await pi.toolResult({
      toolName: "bash",
      toolCallId: "b1",
      text: "hi",
      structuredContent: { output: "hi\n", exit_code: 0, truncated: false, wall_time_seconds: 0 },
    });
    expect(result.text).toMatch(/^\[exit 0 · \d+,\d с · 3 Б\]\nhi$/);
    // structuredContent для codemode сохраняется.
    expect(result.structuredContent).toMatchObject({ exit_code: 0 });
  });

  it("on a failing command Pi kept only the tail; we show head and tail from the full output", async () => {
    const { pi, dir } = await setup();
    const full = `FATAL: config missing at the start\n${lines(3000)}`;
    const fullPath = join(dir, "pi-bash-full.log");
    await writeFile(fullPath, full);
    const piTail = lines(3000).split("\n").slice(-2000).join("\n");
    const text = `${piTail}\n\n[Showing lines 1002-3001 of 3001. Full output: ${fullPath}]\n\nCommand exited with code 2`;
    const result = await pi.toolResult({
      toolName: "bash",
      text,
      isError: true,
      details: { fullOutputPath: fullPath },
      structuredContent: { output: full, exit_code: 2, truncated: true, wall_time_seconds: 1.5 },
    });
    expect(result.text.startsWith("[exit 2 · 1,5 с · ")).toBe(true);
    expect(result.text).toContain(`полностью: ${fullPath}`);
    expect(result.text).toContain("FATAL: config missing at the start");
    expect(result.text).toContain("line 3000 ");
    expect(result.text).toContain("Command exited with code 2");
    expect(Buffer.byteLength(result.text)).toBeLessThan(31 * 1024);
  });

  it("cuts bash output between 30 and 50 KB that Pi passed through and saves it to a file", async () => {
    const { pi } = await setup();
    const big = lines(800); // ≈ 40 КБ, меньше лимита Pi
    const result = await pi.toolResult({ toolName: "bash", toolCallId: "big", text: big });
    const path = /полностью: (\S+)\]/.exec(result.text)?.[1];
    expect(path).toBeDefined();
    expect(await readFile(path as string, "utf8")).toBe(big);
    expect(result.text).toContain("line 1 ");
    expect(result.text).toContain("line 800 ");
    expect(result.text).toContain("пропущено");
  });

  it("marks timeouts in the header", async () => {
    const { pi } = await setup();
    const result = await pi.toolResult({
      toolName: "bash",
      text: "partial\n\nCommand timed out after 120 seconds",
      isError: true,
    });
    expect(result.text.startsWith("[таймаут · ")).toBe(true);
  });

  it("limits read to 30 KB and says which offset to continue from", async () => {
    const { pi } = await setup();
    const result = await pi.toolResult({
      toolName: "read",
      input: { path: "big.txt", offset: 100 },
      text: lines(1000),
    });
    const match = /Показаны строки 100–(\d+) .*offset=(\d+)/.exec(result.text);
    expect(match).not.toBeNull();
    expect(Number(match?.[2])).toBe(Number(match?.[1]) + 1);
    expect(Buffer.byteLength(result.text)).toBeLessThan(31 * 1024);
  });

  it("spills large results of other tools (grep, MCP) to a file with a preview", async () => {
    const { pi } = await setup();
    const result = await pi.toolResult({ toolName: "grep", text: lines(2000) });
    expect(result.text).toMatch(/^\[\d+,\d КБ · показаны начало и конец, полностью: /);
  });

  it("leaves small non-bash results and edits alone", async () => {
    const { pi } = await setup();
    expect((await pi.toolResult({ toolName: "read", text: "small" })).modified).toBe(false);
    expect((await pi.toolResult({ toolName: "edit", text: lines(2000) })).modified).toBe(false);
  });
});

describe("headTail", () => {
  it("keeps both ends within the limit", () => {
    const text = lines(5000);
    const out = headTail(text, 10_000);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(10_100);
    expect(out.startsWith("line 1 ")).toBe(true);
    expect(out.trimEnd().endsWith("x".repeat(40))).toBe(true);
    expect(out).toContain("line 5000 ");
  });
});
