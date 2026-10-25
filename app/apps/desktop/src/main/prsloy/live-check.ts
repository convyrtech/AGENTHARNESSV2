/**
 * Live gateway check (developer tool, scripts/live-gateway-check.mts): every text model the
 * gateway lists, through the same provider code as the app — pi runtime, the PRSLOY
 * models.json catalog, the host's fetch wrapper (max_tokens step-down, model fallback).
 *
 * Per model, at most three short requests:
 *   stream      «ответь одним словом» — text arrives in deltas
 *   thinking    the same request: the body carries our compat fields; reasoning comes back
 *   max_tokens  the same request: 128 000 accepted, or which step-down worked
 *   usage       the same request: usage tokens and the cost pi computes from our price table
 *   tool        read a file with `read` and answer from it (call + answer = 2 requests);
 *               reasoning of the call is replayed in the second request
 *
 * The key is taken from the caller (env) only and scrubbed from every note.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPixRuntime } from "../../../../../packages/agent-runtime/src/index.ts";
import { createPrsloyFetch } from "../../agent-host/prsloy-fetch.ts";
import {
  buildPrsloyModelsJsonProvider,
  isPrsloyChatModelId,
  PRSLOY_MAX_TOKENS,
  PRSLOY_MODELS,
  PRSLOY_PROVIDER_ID,
  prsloyModelCost,
} from "../../shared/prsloy-config.ts";

export const LIVE_CHECKS = ["stream", "thinking", "max_tokens", "usage", "tool"] as const;
export type LiveCheckName = (typeof LIVE_CHECKS)[number];
export type LiveCheckResult = { ok: boolean | null; note: string };
export type LiveCheckRow = { model: string } & Record<LiveCheckName, LiveCheckResult>;
export type LiveCheckReport = {
  baseUrl: string;
  at: string;
  listed: string[];
  skipped: string[];
  rows: LiveCheckRow[];
};

type Recorded = { model: string; body: Record<string, unknown>; status: number };

const FILE_TEXT = "PRSLOY-LIVE-42";
const STREAM_PROMPT = "Ответь одним словом: привет.";
const TOOL_PROMPT =
  "Прочитай файл ok.txt инструментом read и ответь его содержимым одной строкой, без пояснений.";

function scrub(text: string, key: string): string {
  return key ? text.split(key).join("***") : text;
}

async function listModels(baseUrl: string, key: string, fetchImpl: typeof fetch) {
  const response = await fetchImpl(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`GET /models → ${response.status}`);
  const body = (await response.json()) as { data?: { id?: unknown }[] };
  return (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
}

/** Which fields our compat must put in the body for this model. */
function expectedThinking(model: string): { fields: string[]; reasoning: boolean } {
  const def = PRSLOY_MODELS.find((m) => m.id === model);
  if (!def || !def.reasoning) return { fields: [], reasoning: false };
  const format = def.compat.thinkingFormat;
  if (format === "deepseek") return { fields: ["thinking", "reasoning_effort"], reasoning: true };
  if (format === "qwen") {
    return {
      fields: ["enable_thinking", "reasoning_effort", "parallel_tool_calls"],
      reasoning: true,
    };
  }
  return { fields: ["reasoning_effort"], reasoning: true };
}

type Message = {
  role?: string;
  stopReason?: string;
  errorMessage?: string;
  content?: { type?: string; text?: string; thinking?: string }[];
  usage?: { input?: number; output?: number; cost?: { total?: number } };
};

function lastAssistant(messages: readonly unknown[]): Message | undefined {
  return [...(messages as Message[])].reverse().find((m) => m.role === "assistant");
}
const textOf = (m: Message | undefined) =>
  (m?.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
const thinkingOf = (m: Message | undefined) =>
  (m?.content ?? [])
    .filter((c) => c.type === "thinking")
    .map((c) => c.thinking ?? "")
    .join("");

export async function runLiveGatewayCheck(options: {
  baseUrl: string;
  apiKey: string;
  /** Only these (still must be listed by the gateway). */
  models?: string[];
  fetch?: typeof fetch;
  timeoutMs?: number;
  log?: (line: string) => void;
}): Promise<LiveCheckReport> {
  const key = options.apiKey;
  const baseUrl = options.baseUrl.replace(/\/+$/u, "");
  const log = options.log ?? (() => undefined);
  const original = options.fetch ?? globalThis.fetch.bind(globalThis);
  const listed = await listModels(baseUrl, key, original);
  const chat = listed.filter(isPrsloyChatModelId);
  const skipped = listed.filter((id) => !isPrsloyChatModelId(id));
  const models = options.models?.length ? chat.filter((id) => options.models!.includes(id)) : chat;

  const root = mkdtempSync(join(tmpdir(), "prsloy-live-"));
  const agentDir = join(root, "agent");
  const workspace = join(root, "project");
  const recorded: Recorded[] = [];
  // Recorder under the app's wrapper: it sees every attempt, step-downs included.
  const recorder: typeof fetch = async (input, init) => {
    const response = await original(input, init);
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : "";
    if (/\/chat\/completions/u.test(url) && typeof init?.body === "string") {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        recorded.push({ model: String(body.model), body, status: response.status });
      } catch {
        // not JSON: not ours
      }
    }
    return response;
  };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = createPrsloyFetch({
    base: recorder,
    apiKey: key,
    listModels: async () => listed,
  });
  const rows: LiveCheckRow[] = [];
  try {
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "ok.txt"), `${FILE_TEXT}\n`);
    writeFileSync(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: { [PRSLOY_PROVIDER_ID]: buildPrsloyModelsJsonProvider(baseUrl, listed) },
      }),
    );
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ defaultProvider: PRSLOY_PROVIDER_ID, defaultModel: models[0] ?? "" }),
    );

    for (const model of models) {
      log(`… ${model}`);
      rows.push(await checkModel(model));
    }
  } finally {
    globalThis.fetch = previousFetch;
    rmSync(root, { recursive: true, force: true });
  }
  return { baseUrl, at: new Date().toISOString(), listed, skipped, rows };

  async function checkModel(model: string): Promise<LiveCheckRow> {
    const na = (note: string): LiveCheckResult => ({ ok: null, note });
    const row: LiveCheckRow = {
      model,
      stream: na("—"),
      thinking: na("—"),
      max_tokens: na("—"),
      usage: na("—"),
      tool: na("—"),
    };
    const fail = (error: unknown) =>
      scrub(error instanceof Error ? error.message : String(error), key).slice(0, 160);
    let handle: Awaited<ReturnType<typeof createPixRuntime>> | undefined;
    try {
      handle = await createPixRuntime({
        cwd: workspace,
        agentDir,
        tools: ["read"],
        runtimeApiKeys: { [PRSLOY_PROVIDER_ID]: key },
        persistSession: false,
        projectTrusted: true,
      });
      await handle.setModel(PRSLOY_PROVIDER_ID, model);
      const session = handle.runtime.session;
      let deltas = 0;
      let toolRuns = 0;
      session.subscribe((event) => {
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          deltas += 1;
        }
        if (event.type === "tool_execution_end") toolRuns += 1;
      });
      const prompt = async (text: string) => {
        let timer: NodeJS.Timeout | undefined;
        const timedOut = await Promise.race([
          session.prompt(text).then(() => false),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(true), options.timeoutMs ?? 180_000);
          }),
        ]);
        if (timer) clearTimeout(timer);
        if (timedOut) {
          await session.abort();
          throw new Error("no answer in time");
        }
      };

      // 1. stream + thinking + max_tokens + usage: one short request.
      const from = recorded.length;
      const started = Date.now();
      try {
        await prompt(STREAM_PROMPT);
      } catch (error) {
        row.stream = { ok: false, note: fail(error) };
      }
      const answer = lastAssistant(session.messages);
      const mine = recorded.slice(from);
      const okRequest = mine.find((r) => r.status === 200);
      if (row.stream.ok !== false) {
        const text = textOf(answer).trim();
        row.stream =
          answer?.stopReason === "error" || !text
            ? { ok: false, note: fail(answer?.errorMessage ?? "empty answer") }
            : {
                ok: deltas > 0,
                note: `${deltas} deltas, ${Date.now() - started} ms: «${text.slice(0, 30)}»`,
              };
      }
      const first = mine[0];
      if (first) {
        const steps = mine.map((r) => `${String(r.body.max_tokens)}→${r.status}`).join(", ");
        const sent = Number(first.body.max_tokens);
        // pi caps the limit at the context window minus the input before sending; that is
        // ours, not a gateway step-down (which only follows a 400).
        const capped =
          sent < PRSLOY_MAX_TOKENS
            ? ` (cap = context window ${PRSLOY_MODELS.find((m) => m.id === model)?.contextWindow ?? "?"} − input)`
            : "";
        row.max_tokens =
          first.status === 200
            ? { ok: true, note: `${sent} accepted${capped}` }
            : okRequest
              ? { ok: true, note: `gateway refused, stepped down: ${steps}` }
              : { ok: false, note: steps };
      }
      const expected = expectedThinking(model);
      if (first) {
        const missing = expected.fields.filter((f) => !(f in first.body));
        const sent = ["thinking", "enable_thinking", "reasoning_effort", "parallel_tool_calls"]
          .filter((f) => f in first.body)
          .map((f) => `${f}=${JSON.stringify(first.body[f])}`)
          .join(" ");
        const reasoning = thinkingOf(answer).length;
        if (!expected.reasoning) {
          row.thinking = {
            ok: sent === "" ? true : false,
            note: sent === "" ? "no effort / thinking sent (as configured)" : `unexpected: ${sent}`,
          };
        } else {
          row.thinking = {
            ok: missing.length === 0 && reasoning > 0,
            note: `${sent || "nothing sent"}; reasoning back: ${reasoning} chars${
              missing.length ? `; missing ${missing.join(", ")}` : ""
            }`,
          };
        }
      }
      const usage = answer?.usage;
      if (usage) {
        const priced = prsloyModelCost(model).input > 0;
        const cost = usage.cost?.total ?? 0;
        const unmetered = (usage.output ?? 0) > 0 && (usage.input ?? 0) === 0;
        row.usage = {
          ok: (usage.input ?? 0) > 0 && (usage.output ?? 0) > 0 && (!priced || cost > 0),
          note: `in ${usage.input ?? 0} / out ${usage.output ?? 0}; ${
            unmetered
              ? "шлюз не прислал input: цена неизвестна (₽ не показываем)"
              : priced
                ? `$${cost.toFixed(6)}`
                : "нет цены (₽ не показываем)"
          }`,
        };
      }

      // 2. tool call + answer: two requests.
      const toolFrom = recorded.length;
      const runsBefore = toolRuns;
      try {
        await prompt(TOOL_PROMPT);
        const final = lastAssistant(session.messages);
        const text = textOf(final);
        const calls = recorded.slice(toolFrom).filter((r) => r.status === 200);
        const replay = calls[1]?.body.messages as
          | { role?: string; tool_calls?: unknown; reasoning_content?: unknown }[]
          | undefined;
        const callMsg = replay?.find((m) => m.role === "assistant" && m.tool_calls);
        const replayNote = expected.reasoning
          ? `; reasoning replayed: ${typeof callMsg?.reasoning_content === "string" ? "yes" : "no"}`
          : "";
        row.tool = {
          ok: toolRuns > runsBefore && text.includes(FILE_TEXT),
          note: `${toolRuns - runsBefore} read call(s), ${calls.length} requests, answer ${
            text.includes(FILE_TEXT) ? "has" : "lacks"
          } the file text${replayNote}`,
        };
      } catch (error) {
        row.tool = { ok: false, note: fail(error) };
      }
    } catch (error) {
      row.stream = { ok: false, note: fail(error) };
    } finally {
      await handle?.dispose().catch(() => undefined);
    }
    return row;
  }
}

/** The table for stdout: model × check, ✅ / ❌ / — and the short reason. */
export function formatLiveReport(report: LiveCheckReport): string {
  const mark = (r: LiveCheckResult) => (r.ok === true ? "✅" : r.ok === false ? "❌" : "—");
  const lines = [
    `Шлюз ${report.baseUrl}, ${report.at}`,
    `В /v1/models: ${report.listed.join(", ")}`,
    report.skipped.length ? `Не текстовые (пропущены): ${report.skipped.join(", ")}` : "",
    "",
    `| модель | ${LIVE_CHECKS.join(" | ")} |`,
    `| --- | ${LIVE_CHECKS.map(() => "---").join(" | ")} |`,
    ...report.rows.map(
      (row) =>
        `| ${row.model} | ${LIVE_CHECKS.map((c) => `${mark(row[c])} ${row[c].note.replaceAll("|", "/")}`).join(" | ")} |`,
    ),
  ];
  return lines.filter((l, i) => l !== "" || i === 3).join("\n");
}
