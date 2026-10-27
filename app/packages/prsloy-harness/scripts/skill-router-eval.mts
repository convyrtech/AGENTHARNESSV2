import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { SKILL_FILES } from "../src/skills-bundle.ts";
import { projectHints, routeSkill } from "../src/skill-router.ts";

interface Label {
  task: string;
  expected: string;
  reason: string;
}

export async function evaluate(options: {
  labels: Label[];
  root: string;
  model: string;
  baseUrl: string;
  key: string;
  fetch: typeof fetch;
}): Promise<{
  rows: { task: string; expected: string; chosen: string; confidence: number; ok: boolean }[];
  tokens: number;
}> {
  let tokens = 0;
  const skills = Object.entries(SKILL_FILES).map(([id, files]) => ({
    id,
    description: /^description: "(.+)"$/m.exec(files["SKILL.md"] ?? "")?.[1] ?? id,
  }));
  const rows = [];
  for (const label of options.labels) {
    const taskPath = join(options.root, "tasks", label.task, "task.json");
    const task = JSON.parse(readFileSync(taskPath, "utf8")) as {
      prompt?: string;
      prompts?: string[];
      suite?: string;
    };
    const request = task.prompt ?? task.prompts?.join("\n") ?? "";
    const cwd = join(options.root, "tasks", label.task, "workspace");
    const ctx = {
      cwd,
      signal: undefined,
      modelRegistry: {
        find: (provider: string, id: string) => ({ provider, id }),
        complete: async (
          model: { provider: string; id: string },
          input: unknown,
          callOptions: { signal: AbortSignal; maxTokens: number },
        ) => {
          const response = await options.fetch(
            `${options.baseUrl.replace(/\/$/, "")}/chat/completions`,
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${options.key}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                model: model.id,
                messages: (input as { messages: unknown[] }).messages,
                max_tokens: callOptions.maxTokens,
              }),
              signal: callOptions.signal,
            },
          );
          if (!response.ok) throw new Error(`gateway ${response.status}`);
          const data = (await response.json()) as {
            choices?: { message?: { content?: string } }[];
            usage?: { total_tokens?: number };
          };
          tokens += data.usage?.total_tokens ?? 0;
          return {
            content: [{ type: "text", text: data.choices?.[0]?.message?.content ?? "" }],
            stopReason: "stop",
          };
        },
      },
    } as never;
    const result = await routeSkill(request, skills, projectHints(cwd), ctx, {
      model: options.model,
    });
    rows.push({
      task: label.task,
      expected: label.expected,
      chosen: result.skill,
      confidence: result.confidence,
      ok: result.skill === label.expected,
    });
  }
  return { rows, tokens };
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      "base-url": { type: "string", default: "https://api.prsloy.online/v1" },
      key: { type: "string" },
      model: { type: "string", default: "deepseek-v4.1-flash-1017" },
    },
  });
  const key = values.key ?? process.env.PRSLOY_GATEWAY_KEY;
  if (!key) throw new Error("Set PRSLOY_GATEWAY_KEY or pass --key");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "bench");
  const labels = JSON.parse(
    readFileSync(join(root, "skill-router-labels.json"), "utf8"),
  ) as Label[];
  const result = await evaluate({
    labels,
    root,
    model: values.model,
    baseUrl: values["base-url"],
    key,
    fetch,
  });
  console.log("task\texpected\tchosen\tconfidence\tok");
  for (const row of result.rows)
    console.log(
      `${row.task}\t${row.expected}\t${row.chosen}\t${row.confidence.toFixed(2)}\t${row.ok}`,
    );
  const wrongLoads = result.rows.filter(
    (row) => row.chosen !== "none" && row.chosen !== row.expected,
  ).length;
  const missed = result.rows.filter(
    (row) => row.expected !== "none" && row.chosen === "none",
  ).length;
  const correct = result.rows.filter((row) => row.ok).length;
  console.log(
    `accuracy\t${correct}/${result.rows.length} (${((100 * correct) / result.rows.length).toFixed(1)}%)`,
  );
  console.log(`wrong loads\t${wrongLoads}\nmissed\t${missed}\ntokens\t${result.tokens}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  process.exitCode = await main().catch((error: unknown) => {
    console.error(error);
    return 2;
  });
