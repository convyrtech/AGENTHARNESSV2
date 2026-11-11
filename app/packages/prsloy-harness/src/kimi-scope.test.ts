import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { type ExploreComplete, type ExploreModel, type ExploreReply } from "./explore.ts";
import { planKimiScope } from "./kimi-scope.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(large = false) {
  const cwd = await mkdtemp(join(tmpdir(), "kimi-scope-"));
  roots.push(cwd);
  await mkdir(join(cwd, "src"));
  await mkdir(join(cwd, "checks"));
  await writeFile(join(cwd, "src", "text.ts"), "export const value = 1;\n");
  await writeFile(join(cwd, "checks", "accept.mjs"), "console.log('pass');\n");
  await writeFile(join(cwd, ".hidden.mjs"), "must not be listed\n");
  if (large) {
    await mkdir(join(cwd, "app", "packages", "prsloy-harness", "src"), { recursive: true });
    await mkdir(join(cwd, "bench-out"), { recursive: true });
    await mkdir(join(cwd, "many"), { recursive: true });
    await writeFile(
      join(cwd, "app", "packages", "prsloy-harness", "src", "text.ts"),
      "export const text = '�';\n",
    );
    await writeFile(join(cwd, "bench-out", "acceptance.mjs"), "console.log('pass');\n");
    for (let i = 0; i < 140; i++) {
      await mkdir(join(cwd, "app", `noise-${String(i).padStart(3, "0")}`), { recursive: true });
      await writeFile(
        join(cwd, "app", `noise-${String(i).padStart(3, "0")}`, "filler.ts"),
        "export {};\n",
      );
    }
    for (let i = 0; i < 170; i++)
      await writeFile(join(cwd, "many", `file-${String(i).padStart(3, "0")}.ts`), "export {};\n");
  }
  return cwd;
}

function reply(text: string): ExploreReply {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    timestamp: Date.now(),
  } as ExploreReply;
}

function toolReply(
  calls: Array<{ name: string; arguments: Record<string, unknown> }>,
): ExploreReply {
  return {
    role: "assistant",
    content: calls.map((call, index) => ({
      type: "toolCall" as const,
      id: `call-${Date.now()}-${index}`,
      name: call.name,
      arguments: call.arguments,
    })),
    stopReason: "toolUse",
    timestamp: Date.now(),
  } as ExploreReply;
}

function planner(
  answer: string,
  onCall?: (context: Parameters<ExploreComplete>[1]) => void,
): ExploreComplete {
  return (async (_model, context) => {
    onCall?.(context);
    return reply(answer);
  }) as ExploreComplete;
}

const inputBase = (cwd: string) => ({
  cwd,
  task: "Fix the � handling in text.ts; keep this exact request.  ",
  model: {} as ExploreModel,
  signal: new AbortController().signal,
  onUsage: (_reply: ExploreReply) => {},
});

describe("Kimi bounded scope planner", () => {
  it("sends the original task to planning and returns a fixed check command", async () => {
    const cwd = await fixture();
    const seen: string[] = [];
    const task = inputBase(cwd).task;
    const result = await planKimiScope({
      ...inputBase(cwd),
      complete: planner('{"paths":["src/text.ts"],"checkFile":"checks/accept.mjs"}', (context) => {
        seen.push(context.systemPrompt ?? "");
        seen.push(
          context.messages
            .map((message) => message.content)
            .flatMap((content) =>
              typeof content === "string"
                ? [content]
                : content.filter((part) => part.type === "text").map((part) => part.text),
            )
            .join("\n"),
        );
      }),
    });

    expect(result).toEqual({
      task,
      paths: ["src/text.ts"],
      check: "node --experimental-strip-types 'checks/accept.mjs'",
    });
    expect(seen.join("\n")).toContain("\\uXXXX");
    expect(seen.join("\n")).toContain(task.trimEnd());
  });

  it("finds relevant files after more than 120 unrelated files using directory-scoped tools", async () => {
    const cwd = await fixture(true);
    const observed: string[] = [];
    let turn = 0;
    const complete: ExploreComplete = (async (_model, context) => {
      observed.push(
        context.messages
          .map((message) =>
            typeof message.content === "string"
              ? message.content
              : message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n"),
          )
          .join("\n"),
      );
      turn++;
      if (turn === 1)
        return toolReply([
          { name: "list_project_files", arguments: {} },
          { name: "list_project_files", arguments: { directory: "app" } },
        ]);
      if (turn === 2)
        return toolReply([
          { name: "list_project_files", arguments: { directory: "app/packages" } },
          { name: "list_project_files", arguments: { directory: "app/packages/prsloy-harness" } },
        ]);
      if (turn === 3)
        return toolReply([
          {
            name: "list_project_files",
            arguments: { directory: "app/packages/prsloy-harness/src" },
          },
          {
            name: "search_project_literal",
            arguments: { query: "�", directory: "app/packages/prsloy-harness/src" },
          },
          { name: "list_project_files", arguments: { directory: "bench-out" } },
        ]);
      return reply(
        '{"paths":["app/packages/prsloy-harness/src/text.ts"],"checkFile":"bench-out/acceptance.mjs"}',
      );
    }) as ExploreComplete;
    const result = await planKimiScope({ ...inputBase(cwd), complete });

    expect(result.paths).toEqual(["app/packages/prsloy-harness/src/text.ts"]);
    expect(result.check).toBe("node --experimental-strip-types 'bench-out/acceptance.mjs'");
    expect(observed.join("\n")).toContain("app/packages/prsloy-harness/src/text.ts");
    expect(observed.join("\n")).toContain("bench-out/acceptance.mjs");
    expect(turn).toBe(4);
  });

  it("marks a broad literal search truncated at its per-call cap", async () => {
    const cwd = await fixture(true);
    let turn = 0;
    const observed: string[] = [];
    const complete: ExploreComplete = (async (_model, context) => {
      observed.push(
        context.messages
          .map((message) =>
            typeof message.content === "string"
              ? message.content
              : message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n"),
          )
          .join("\n"),
      );
      turn++;
      if (turn === 1)
        return toolReply([
          {
            name: "search_project_literal",
            arguments: { query: "not-present", directory: "many" },
          },
        ]);
      return reply('{"paths":["src/text.ts"],"checkFile":"checks/accept.mjs"}');
    }) as ExploreComplete;
    await planKimiScope({ ...inputBase(cwd), complete });
    expect(observed.join("\n")).toContain("Search truncated by safety cap");
  });

  it.each([
    ["overlap", '{"paths":["src/text.ts","checks/accept.mjs"],"checkFile":"checks/accept.mjs"}'],
    ["case-insensitive overlap", '{"paths":["src/text.mjs"],"checkFile":"SRC/TEXT.MJS"}'],
    ["outside bounded list", '{"paths":["missing.ts"],"checkFile":"checks/accept.mjs"}'],
    ["hidden file", '{"paths":[".hidden.mjs"],"checkFile":"checks/accept.mjs"}'],
    ["non-script check", '{"paths":["src/text.ts"],"checkFile":"src/text.ts"}'],
    ["shell injection check path", '{"paths":["src/text.ts"],"checkFile":"checks/it\'s.mjs"}'],
    [
      "extra JSON key",
      '{"paths":["src/text.ts"],"checkFile":"checks/accept.mjs","command":"echo unsafe"}',
    ],
  ])("rejects %s plans without running a model", async (_name, answer) => {
    const cwd = await fixture();
    await expect(
      planKimiScope({
        ...inputBase(cwd),
        complete: planner(answer),
      }),
    ).rejects.toThrow();
  });
});
