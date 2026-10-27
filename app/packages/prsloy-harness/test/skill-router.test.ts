import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { parseRoute, projectHints, routerPrompt, routeSkill } from "../src/skill-router.ts";
import { evaluate } from "../scripts/skill-router-eval.mts";

const root = mkdtempSync(join(tmpdir(), "skill-router-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const skills = [{ id: "fix-code", description: "Repair broken code." }];

describe("skill router", () => {
  it("prompts for one skill with project clues and strict JSON", () => {
    const prompt = routerPrompt("Fix this", skills, ["2 top-level files"]);
    expect(prompt).toContain('"confidence":0..1');
    expect(prompt).toContain("fix-code: Repair broken code.");
    expect(prompt).toContain("2 top-level files");
  });

  it("parses valid routes and fails closed", () => {
    expect(parseRoute('{"skill":"fix-code","confidence":0.8}', ["fix-code"])).toEqual({
      skill: "fix-code",
      confidence: 0.8,
    });
    expect(parseRoute('{"skill":"other","confidence":0.9}', ["fix-code"])).toEqual({
      skill: "none",
      confidence: 0,
    });
    expect(parseRoute("not json", ["fix-code"])).toEqual({ skill: "none", confidence: 0 });
    expect(parseRoute('{"skill":"none","confidence":1.1}', ["fix-code"])).toEqual({
      skill: "none",
      confidence: 0,
    });
  });

  it("reports only top-level metadata and caps the result", () => {
    const cwd = join(root, "project");
    mkdirSync(cwd);
    writeFileSync(join(cwd, "main.py"), "secret-content-must-not-be-read");
    writeFileSync(join(cwd, "requirements.txt"), "secret-content-must-not-be-read");
    mkdirSync(join(cwd, "nested"));
    writeFileSync(join(cwd, "nested", "ignored.js"), "ignored");
    const hints = projectHints(cwd, 3);
    expect(hints).toContain("2 top-level files");
    expect(hints.join(" ")).not.toContain("secret-content");
    expect(hints.length).toBeLessThanOrEqual(3);
  });

  it("routes through an injected fake model registry and falls back on errors", async () => {
    const mockCtx = {
      cwd: root,
      signal: undefined,
      modelRegistry: {
        find: (provider: string, id: string) => ({ provider, id }),
        complete: async () => ({
          content: [{ type: "text", text: '{"skill":"fix-code","confidence":0.91}' }],
          stopReason: "stop",
        }),
      },
    };
    const ctx = mockCtx as never;
    expect(await routeSkill("Fix it", skills, [], ctx)).toEqual({
      skill: "fix-code",
      confidence: 0.91,
    });
    const failed = {
      cwd: root,
      signal: undefined,
      modelRegistry: { find: () => undefined },
    } as never;
    expect(await routeSkill("Fix it", skills, [], failed)).toEqual({
      skill: "none",
      confidence: 0,
    });
  });

  it("evaluates rows and token totals with fake fetch", async () => {
    const taskDir = join(root, "tasks", "example");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "task.json"), JSON.stringify({ prompt: "Fix it" }));
    const result = await evaluate({
      labels: [{ task: "example", expected: "fix-code", reason: "test" }],
      root,
      model: "deepseek-v4.1-flash-1017",
      baseUrl: "http://fake/v1",
      key: "test-key",
      fetch: async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"skill":"fix-code","confidence":0.95}' } }],
            usage: { total_tokens: 17 },
          }),
          { status: 200 },
        ),
    });
    expect(result.rows).toEqual([
      { task: "example", expected: "fix-code", chosen: "fix-code", confidence: 0.95, ok: true },
    ]);
    expect(result.tokens).toBe(17);
  });
});
