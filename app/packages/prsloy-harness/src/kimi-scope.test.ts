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
  answer: (context: Parameters<ExploreComplete>[1]) => ExploreReply,
  onCall?: (context: Parameters<ExploreComplete>[1]) => void,
): ExploreComplete {
  return (async (_model, context) => {
    onCall?.(context);
    return answer(context);
  }) as ExploreComplete;
}

function finalInput(context: Parameters<ExploreComplete>[1]): {
  task: string;
  files: Array<{ id: string; path: string }>;
  checks: Array<{ id: string; path: string }>;
  discovery: unknown[];
} {
  const message = context.messages[0]?.content;
  if (typeof message !== "string") throw new Error("Expected one JSON planning message");
  return JSON.parse(message) as ReturnType<typeof finalInput>;
}

function submitIds(
  context: Parameters<ExploreComplete>[1],
  filePath: string,
  checkPath: string,
): ExploreReply {
  const input = finalInput(context);
  const file = input.files.find((candidate) => candidate.path === filePath);
  const check = input.checks.find((candidate) => candidate.path === checkPath);
  if (!file || !check) throw new Error("Expected paths to have been discovered and indexed");
  return toolReply([
    { name: "submit_scope_plan", arguments: { fileIds: [file.id], checkId: check.id } },
  ]);
}

const inputBase = (cwd: string) => ({
  cwd,
  task: "Fix the � handling in text.ts; keep this exact request.  ",
  model: { api: "openai-completions" } as ExploreModel,
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
      complete: planner(
        (context) => {
          if (context.tools?.some((tool) => tool.name === "read_project_file"))
            return toolReply([
              { name: "list_project_files", arguments: { directory: "src" } },
              { name: "read_project_file", arguments: { path: "src/text.ts" } },
            ]);
          return submitIds(context, "src/text.ts", "checks/accept.mjs");
        },
        (context) => {
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
        },
      ),
    });

    expect(result).toEqual({
      task,
      paths: ["src/text.ts"],
      check: "node --experimental-strip-types 'checks/accept.mjs'",
    });
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
          {
            name: "find_project_files",
            arguments: { query: "text.ts", directory: "app/packages/prsloy-harness/src" },
          },
          { name: "list_project_files", arguments: { directory: "bench-out" } },
        ]);
      return toolReply([
        {
          name: "read_project_file",
          arguments: { path: "app/packages/prsloy-harness/src/text.ts" },
        },
      ]);
    }) as ExploreComplete;
    const result = await planKimiScope({
      ...inputBase(cwd),
      complete: (async (model, context, options) => {
        if (context.tools?.some((tool) => tool.name === "submit_scope_plan"))
          return submitIds(
            context,
            "app/packages/prsloy-harness/src/text.ts",
            "bench-out/acceptance.mjs",
          );
        return complete(model, context, options);
      }) as ExploreComplete,
    });

    expect(result.paths).toEqual(["app/packages/prsloy-harness/src/text.ts"]);
    expect(result.check).toBe("node --experimental-strip-types 'bench-out/acceptance.mjs'");
    expect(observed.join("\n")).toContain("app/packages/prsloy-harness/src/text.ts");
    expect(observed.join("\n")).toContain("bench-out/acceptance.mjs");
    expect(turn).toBe(4);
  });

  it("ends persistent discovery and starts a fresh request with only the plan schema", async () => {
    const cwd = await fixture();
    let discoveryTurns = 0;
    let paidCalls = 0;
    const complete: ExploreComplete = async (_model, context, options) => {
      if (context.tools?.some((tool) => tool.name === "read_project_file")) {
        discoveryTurns++;
        return toolReply([{ name: "read_project_file", arguments: { path: "src/text.ts" } }]);
      }
      expect(context.messages.map((message) => message.role)).toEqual(["user"]);
      const input = finalInput(context);
      expect(input.task).toContain("Fix the � handling");
      expect(input.files.map(({ path }) => path)).toContain("src/text.ts");
      expect(input.checks.map(({ path }) => path)).toContain("checks/accept.mjs");
      const schema = context.tools?.find((tool) => tool.name === "submit_scope_plan")?.parameters;
      expect(schema).toMatchObject({
        required: ["fileIds", "checkId"],
        additionalProperties: false,
        properties: {
          fileIds: {
            maxItems: input.files.length,
            items: { enum: input.files.map(({ id }) => id) },
          },
          checkId: { enum: input.checks.map(({ id }) => id) },
        },
      });
      expect(options.onPayload?.({ model: "kimi" })).toEqual({
        model: "kimi",
        tool_choice: "required",
      });
      return submitIds(context, "src/text.ts", "checks/accept.mjs");
    };
    const plan = await planKimiScope({
      ...inputBase(cwd),
      complete,
      onUsage: () => paidCalls++,
    });
    expect(plan.paths).toEqual(["src/text.ts"]);
    expect(discoveryTurns).toBe(4);
    expect(paidCalls).toBe(5);
  });

  it("rejects another search in the final reply without another request", async () => {
    const cwd = await fixture();
    let requests = 0;
    const complete: ExploreComplete = async (_model, context) => {
      requests++;
      if (context.tools?.some((tool) => tool.name === "submit_scope_plan"))
        return toolReply([{ name: "read_project_file", arguments: { path: "src/text.ts" } }]);
      return toolReply([
        { name: "find_project_files", arguments: { query: "text.ts" } },
        { name: "list_project_files", arguments: { directory: "src" } },
        {
          name: "read_project_file",
          arguments: { path: "src/text.ts" },
        },
      ]);
    };
    await expect(planKimiScope({ ...inputBase(cwd), complete })).rejects.toThrow(
      "only submit the scope plan",
    );
    expect(requests).toBe(5);
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
      if (context.tools?.some((tool) => tool.name === "submit_scope_plan"))
        return submitIds(
          context,
          "app/packages/prsloy-harness/src/text.ts",
          "bench-out/acceptance.mjs",
        );
      return toolReply([
        {
          name: "read_project_file",
          arguments: { path: "app/packages/prsloy-harness/src/text.ts" },
        },
      ]);
    }) as ExploreComplete;
    await planKimiScope({ ...inputBase(cwd), complete });
    expect(observed.join("\n")).toContain("Search truncated by safety cap");
  });

  it.each([
    ["unknown file ID", () => ({ fileIds: ["F999"], checkId: "C1" })],
    ["raw file path", () => ({ fileIds: ["src/text.ts"], checkId: "C1" })],
    [
      "unknown check ID",
      (context: Parameters<ExploreComplete>[1]) => ({
        fileIds: [finalInput(context).files.find(({ path }) => path === "src/text.ts")!.id],
        checkId: "C999",
      }),
    ],
    [
      "raw check path",
      (context: Parameters<ExploreComplete>[1]) => ({
        fileIds: [finalInput(context).files.find(({ path }) => path === "src/text.ts")!.id],
        checkId: "checks/accept.mjs",
      }),
    ],
    [
      "check ID submitted as a file",
      (context: Parameters<ExploreComplete>[1]) => ({
        fileIds: [finalInput(context).checks[0]!.id],
        checkId: finalInput(context).checks.find(({ path }) => path === "checks/accept.mjs")!.id,
      }),
    ],
    [
      "file ID submitted as a check",
      (context: Parameters<ExploreComplete>[1]) => ({
        fileIds: [finalInput(context).files.find(({ path }) => path === "src/text.ts")!.id],
        checkId: finalInput(context).files.find(({ path }) => path === "src/text.ts")!.id,
      }),
    ],
  ])("rejects %s plans", async (_name, argumentsFor) => {
    const cwd = await fixture();
    await expect(
      planKimiScope({
        ...inputBase(cwd),
        complete: planner((context) => {
          if (!context.tools?.some((tool) => tool.name === "submit_scope_plan"))
            return toolReply([
              { name: "list_project_files", arguments: { directory: "src" } },
              { name: "read_project_file", arguments: { path: "src/text.ts" } },
            ]);
          return toolReply([{ name: "submit_scope_plan", arguments: argumentsFor(context) }]);
        }),
      }),
    ).rejects.toThrow();
  });
});
