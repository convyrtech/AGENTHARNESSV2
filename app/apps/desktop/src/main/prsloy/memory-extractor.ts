/**
 * M-sp (research/24 §3.1, §3.3): a model call outside any turn, from main, after the user
 * left a chat. One process, one queue: the parked hosts (up to 5, reaped after 10 min) are
 * never asked. Its price goes to its own journal, `prsloy-memory/extractor.jsonl`, never
 * into anybody's session; no texts there, only the model, tokens, time and cost.
 *
 * Probe mode (PRSLOY_MEMORY_EXTRACTOR=probe) asks for a fixed JSON with no user data: the
 * pipe is proven on Windows and Linux before M-3 puts the user's own words through it.
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { memoryDirFor } from "@prsloy/harness";
import {
  isPrsloyChatModelId,
  prsloyModelCost,
  prsloySpeedModelId,
} from "../../shared/prsloy-config.ts";
import type { FetchLike } from "./gateway-check.ts";
import { onSessionLeft } from "./session-left.ts";

/** Cheapest that meters input on the gateway first (deepseek reports no input tokens yet). */
const EXTRACTOR_MODELS = ["qwen3.8-max", "deepseek-v4.1-flash-1017"];

export function extractorModel(available: readonly string[] | undefined): string {
  if (available?.length) {
    const served = available.filter(isPrsloyChatModelId);
    return EXTRACTOR_MODELS.find((m) => served.includes(m)) ?? prsloySpeedModelId("fast", served);
  }
  return EXTRACTOR_MODELS[0]!;
}

export type ExtractorRun = {
  ts: string;
  kind: "probe";
  /** sha256 of the session file path, first 16: which chat, without its name. */
  session: string;
  model: string;
  ok: boolean;
  status: number;
  ms: number;
  input: number;
  output: number;
  /** null: price unknown (no price for the model, or the gateway metered no input). */
  costUsd: number | null;
  /** The answer parsed as the JSON we asked for. */
  json: boolean;
  error?: string;
};

const PROBE_MESSAGES = [
  { role: "system", content: 'Ответь строго одним JSON-объектом: {"ok":true}. Без пояснений.' },
  { role: "user", content: "проверка" },
];

export async function runExtractorProbe(options: {
  baseUrl: string;
  apiKey: string;
  model: string;
  sessionFile: string;
  journalDir: string;
  fetch: FetchLike;
  timeoutMs?: number;
  now?: () => Date;
}): Promise<ExtractorRun> {
  const started = Date.now();
  const run: ExtractorRun = {
    ts: (options.now?.() ?? new Date()).toISOString(),
    kind: "probe",
    session: createHash("sha256").update(options.sessionFile).digest("hex").slice(0, 16),
    model: options.model,
    ok: false,
    status: 0,
    ms: 0,
    input: 0,
    output: 0,
    costUsd: null,
    json: false,
  };
  try {
    const response = await options.fetch(
      `${options.baseUrl.replace(/\/+$/u, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          model: options.model,
          messages: PROBE_MESSAGES,
          max_tokens: 64,
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
      },
    );
    run.status = response.status;
    const body = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    let text = "";
    for (const line of body.split("\n")) {
      const data = line.startsWith("data:") ? line.slice(5).trim() : "";
      if (!data || data === "[DONE]") continue;
      try {
        const chunk = JSON.parse(data) as {
          choices?: { delta?: { content?: string } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        text += chunk.choices?.[0]?.delta?.content ?? "";
        if (chunk.usage) {
          run.input = chunk.usage.prompt_tokens ?? 0;
          run.output = chunk.usage.completion_tokens ?? 0;
        }
      } catch {
        // a keep-alive or a vendor line
      }
    }
    run.ok = text.trim().length > 0;
    try {
      run.json = (JSON.parse(text.trim()) as { ok?: unknown }).ok === true;
    } catch {
      run.json = false;
    }
    const price = prsloyModelCost(options.model);
    const metered = run.input > 0 || run.output === 0;
    run.costUsd =
      price.input > 0 && metered
        ? (run.input * price.input + run.output * price.output) / 1e6
        : null;
  } catch (error) {
    run.error = (error instanceof Error ? error.message : String(error)).slice(0, 120);
  }
  run.ms = Date.now() - started;
  try {
    mkdirSync(options.journalDir, { recursive: true });
    appendFileSync(join(options.journalDir, "extractor.jsonl"), `${JSON.stringify(run)}\n`);
  } catch (error) {
    console.warn("[prsloy] extractor journal:", error);
  }
  return run;
}

/**
 * The queue: one call at a time, each session once per app run. Turned on only by
 * PRSLOY_MEMORY_EXTRACTOR=probe (owner and developer builds); off, it does nothing.
 */
export function installMemoryExtractor(options: {
  mode: string | undefined;
  agentDir: string;
  baseUrl: () => string;
  apiKey: () => string | undefined;
  availableModels: () => readonly string[] | undefined;
  fetch: FetchLike;
  /** Model override (tests). */
  model?: string | undefined;
  onRun?: (run: ExtractorRun) => void;
}): { stop(): void; idle(): Promise<void> } {
  if (options.mode !== "probe") return { stop: () => undefined, idle: async () => undefined };
  const done = new Set<string>();
  let chain: Promise<void> = Promise.resolve();
  const stop = onSessionLeft((sessionFile) => {
    if (done.has(sessionFile)) return;
    done.add(sessionFile);
    chain = chain.then(async () => {
      const apiKey = options.apiKey();
      if (!apiKey) return;
      const run = await runExtractorProbe({
        baseUrl: options.baseUrl(),
        apiKey,
        model: options.model ?? extractorModel(options.availableModels()),
        sessionFile,
        journalDir: memoryDirFor(options.agentDir),
        fetch: options.fetch,
      });
      options.onRun?.(run);
    });
  });
  return { stop, idle: () => chain };
}

/**
 * Test mode only (ZENO_ENABLE_TEST_COMMANDS=1): send the probe to another models.json
 * provider (the fake model), whose URL is only known once the test has started it.
 */
export function testProviderEndpoint(
  agentDir: string,
  provider: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { baseUrl: string; apiKey: string } | undefined {
  if (!provider || env.ZENO_ENABLE_TEST_COMMANDS !== "1") return undefined;
  try {
    const models = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8")) as {
      providers?: Record<string, { baseUrl?: unknown; apiKey?: unknown }>;
    };
    const entry = models.providers?.[provider];
    if (typeof entry?.baseUrl !== "string") return undefined;
    return {
      baseUrl: entry.baseUrl,
      apiKey: typeof entry.apiKey === "string" ? entry.apiKey : "test",
    };
  } catch {
    return undefined;
  }
}
