/**
 * M-sp (research/24 §3.1, §3.3): a model call outside any turn, from main, after the user
 * left a chat. One process, one queue: the parked hosts (up to 5, reaped after 10 min) are
 * never asked. Its price goes to its own journal, `prsloy-memory/extractor.jsonl`, never
 * into anybody's session; no texts there, only the model, tokens, time and cost.
 *
 * Probe mode (PRSLOY_MEMORY_EXTRACTOR=probe) asks for a fixed JSON with no user data: the
 * pipe is proven on Windows and Linux before M-3 puts the user's own words through it.
 *
 * Shadow mode (M-3, research/24 §3.1): PRSLOY_MEMORY_EXTRACTOR=shadow, or memory on with
 * `autoMemory` "shadow" / true in the owner's prsloy-harness.json. The user's own words since
 * the session's watermark (harness `extractorInput`, M-2) → signals → one JSON call only when
 * there is a signal → the §3.4 checks → candidates in `prsloy-memory/candidates.jsonl`. Nothing
 * goes into the memory files or the prompt. At start, ≤2 sessions left unprocessed catch up.
 */
import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  autoDetails,
  type Candidate,
  checkCandidates,
  MEMORY_CARD,
  MEMORY_TEXT,
  updatedDetails,
  type ExtractorOp,
  type MemoryEntry,
  type MemorySignalKind,
  extractorInput,
  extractorPrompt,
  memoryDirFor,
  MemoryStore,
  parseExtractorReply,
  sessionSignals,
  withMemoryLock,
} from "@prsloy/harness";
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
  kind: "probe" | "extract";
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
  /** extract: user messages since the watermark, those with a signal, ops by verdict. */
  messages?: number;
  signals?: number;
  ops?: number;
  accepted?: number;
  /** extract, write mode: entries added or replaced. */
  written?: number;
  /** extract: no signal → no model call. */
  skipped?: "no-signal" | "no-messages";
};

const sessionHash = (sessionFile: string) =>
  createHash("sha256").update(sessionFile).digest("hex").slice(0, 16);

type GatewayCall = {
  status: number;
  text: string;
  input: number;
  output: number;
  costUsd: number | null;
  error?: string;
};

/** One streamed chat call with usage; never throws. */
async function callGateway(options: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: { role: string; content: string }[];
  maxTokens: number;
  fetch: FetchLike;
  timeoutMs?: number;
}): Promise<GatewayCall> {
  const out: GatewayCall = { status: 0, text: "", input: 0, output: 0, costUsd: null };
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
          messages: options.messages,
          max_tokens: options.maxTokens,
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
      },
    );
    out.status = response.status;
    const body = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    for (const line of body.split("\n")) {
      const data = line.startsWith("data:") ? line.slice(5).trim() : "";
      if (!data || data === "[DONE]") continue;
      try {
        const chunk = JSON.parse(data) as {
          choices?: { delta?: { content?: string } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        out.text += chunk.choices?.[0]?.delta?.content ?? "";
        if (chunk.usage) {
          out.input = chunk.usage.prompt_tokens ?? 0;
          out.output = chunk.usage.completion_tokens ?? 0;
        }
      } catch {
        // a keep-alive or a vendor line
      }
    }
    const price = prsloyModelCost(options.model);
    const metered = out.input > 0 || out.output === 0;
    out.costUsd =
      price.input > 0 && metered
        ? (out.input * price.input + out.output * price.output) / 1e6
        : null;
  } catch (error) {
    out.error = (error instanceof Error ? error.message : String(error)).slice(0, 120);
  }
  return out;
}

function journalRun(journalDir: string, run: ExtractorRun): void {
  try {
    mkdirSync(journalDir, { recursive: true });
    appendFileSync(join(journalDir, "extractor.jsonl"), `${JSON.stringify(run)}\n`);
  } catch (error) {
    console.warn("[prsloy] extractor journal:", error);
  }
}

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
  const ts = (options.now?.() ?? new Date()).toISOString();
  const call = await callGateway({ ...options, messages: PROBE_MESSAGES, maxTokens: 64 });
  let json = false;
  try {
    json = (JSON.parse(call.text.trim()) as { ok?: unknown }).ok === true;
  } catch {
    json = false;
  }
  const run: ExtractorRun = {
    ts,
    kind: "probe",
    session: sessionHash(options.sessionFile),
    model: options.model,
    ok: !call.error && call.text.trim().length > 0,
    status: call.status,
    ms: Date.now() - started,
    input: call.input,
    output: call.output,
    costUsd: call.error ? null : call.costUsd,
    json,
    ...(call.error ? { error: call.error } : {}),
  };
  journalRun(options.journalDir, run);
  return run;
}

/**
 * One extractor call on already selected messages (with their signals) and the current
 * memory: prompt → model → parse → §3.4 checks. Shared by the shadow run and the live check
 * (scripts/memory-shadow-check.mts).
 */
export async function extractOnce(options: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: { id: string; text: string; kinds: MemorySignalKind[] }[];
  memory: { user: MemoryEntry[]; project: MemoryEntry[] };
  isForgotten?: (scope: "user" | "project", text: string) => boolean;
  fetch: FetchLike;
  timeoutMs?: number;
}): Promise<{ call: GatewayCall; ops: ExtractorOp[] | undefined; candidates: Candidate[] }> {
  const call = await callGateway({
    ...options,
    messages: [{ role: "user", content: extractorPrompt(options.messages, options.memory) }],
    maxTokens: 800,
  });
  const ops = call.error ? undefined : parseExtractorReply(call.text);
  const candidates = checkCandidates(
    ops ?? [],
    options.messages,
    options.memory,
    options.isForgotten,
  );
  return { call, ops, candidates };
}

/** Per session (hash of the path): the id of the last user message already looked at. */
const STATE_FILE = "extractor-state.json";
type ExtractorState = { sessions: Record<string, { watermark: string; at: string }> };

function readState(dir: string): ExtractorState {
  try {
    const raw = JSON.parse(readFileSync(join(dir, STATE_FILE), "utf8")) as ExtractorState;
    return raw && typeof raw.sessions === "object" ? raw : { sessions: {} };
  } catch {
    return { sessions: {} };
  }
}

function saveWatermark(dir: string, session: string, watermark: string, at: string): void {
  withMemoryLock(dir, () => {
    const state = readState(dir);
    state.sessions[session] = { watermark, at };
    writeFileSync(join(dir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
  });
}

function readSession(sessionFile: string): { entries: unknown[]; id?: string; cwd?: string } {
  const entries: unknown[] = [];
  let id: string | undefined;
  let cwd: string | undefined;
  for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { type?: string; id?: string; cwd?: string };
      if (entry.type === "session") {
        id = entry.id;
        cwd = entry.cwd;
      }
      entries.push(entry);
    } catch {
      // a torn last line while the host writes
    }
  }
  return { entries, ...(id ? { id } : {}), ...(cwd ? { cwd } : {}) };
}

/** «Отменить» times for this session from the learning log (`turn.undo`, no texts). */
function undoTimes(learningDir: string, sessionId: string | undefined): string[] {
  if (!sessionId) return [];
  try {
    return readFileSync(join(learningDir, "events.jsonl"), "utf8")
      .split("\n")
      .flatMap((line) => {
        try {
          const e = JSON.parse(line) as { kind?: string; session?: string; ts?: string };
          return e.kind === "turn.undo" && e.session === sessionId && e.ts ? [e.ts] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

/** Is there anything new with a signal in this session since its watermark? (No model call.) */
export function sessionHasSignal(agentDir: string, sessionFile: string): boolean {
  try {
    const dir = memoryDirFor(agentDir);
    const { entries } = readSession(sessionFile);
    const watermark = readState(dir).sessions[sessionHash(sessionFile)]?.watermark;
    return sessionSignals(extractorInput(entries, watermark).messages).length > 0;
  } catch {
    return false;
  }
}

/**
 * M-3 in the shadow: one session since its watermark → candidates.jsonl. The watermark moves
 * only when the call went through (or there was nothing to send), so a failed call is retried.
 */
export async function runExtractorShadow(options: {
  baseUrl: string;
  apiKey: string;
  model: string;
  sessionFile: string;
  agentDir: string;
  learningDir: string;
  fetch: FetchLike;
  timeoutMs?: number;
  now?: () => Date;
  /** M-3b: write accepted candidates (origin "auto") and show cards through `note`. */
  write?: boolean;
  note?: (customType: string, text: string, details: Record<string, unknown>) => Promise<void>;
}): Promise<ExtractorRun> {
  const started = Date.now();
  const ts = (options.now?.() ?? new Date()).toISOString();
  const dir = memoryDirFor(options.agentDir);
  const session = sessionHash(options.sessionFile);
  const base: ExtractorRun = {
    ts,
    kind: "extract",
    session,
    model: options.model,
    ok: true,
    status: 0,
    ms: 0,
    input: 0,
    output: 0,
    costUsd: null,
    json: false,
  };
  const { entries, id, cwd } = readSession(options.sessionFile);
  const watermark = readState(dir).sessions[session]?.watermark;
  const input = extractorInput(entries, watermark, undoTimes(options.learningDir, id));
  const signals = sessionSignals(input.messages);
  const finish = (run: ExtractorRun) => {
    run.ms = Date.now() - started;
    journalRun(dir, run);
    return run;
  };
  if (!signals.length) {
    if (input.watermark) saveWatermark(dir, session, input.watermark, ts);
    return finish({
      ...base,
      messages: input.messages.length,
      signals: 0,
      skipped: input.messages.length ? "no-signal" : "no-messages",
    });
  }
  const store = new MemoryStore(dir);
  const workspace = cwd ?? "";
  const memory = {
    user: store.entries("user", workspace),
    project: cwd ? store.entries("project", cwd) : [],
  };
  const kinds = new Map(signals.map((s) => [s.id, s.kinds]));
  const selected = input.messages
    .filter((m) => kinds.has(m.id))
    .map((m) => ({ id: m.id, text: m.text, kinds: kinds.get(m.id)! }));
  const result = await extractOnce({
    ...options,
    messages: selected,
    memory,
    isForgotten: (scope, text) => store.isForgotten(scope, workspace, text),
  });
  const { call, ops } = result;
  const candidates = result.candidates.filter((c) => c.scope === "user" || cwd);
  const applied = new Map<Candidate, string>();
  if (options.write && !call.error) await writeCandidates();
  async function writeCandidates(): Promise<void> {
    const norm = (t: string) => t.replace(/\s+/g, " ").trim().toLowerCase();
    const noticed: { scope: "user" | "project"; entry: MemoryEntry }[] = [];
    let updated:
      | { opId: string; scope: "user" | "project"; before: MemoryEntry; after: MemoryEntry }
      | undefined;
    for (const c of candidates) {
      if (c.verdict !== "ok") continue;
      const message = selected.find((m) => norm(m.text).includes(norm(c.quote)))?.id;
      const scopeCwd = c.scope === "project" ? cwd! : workspace;
      const result = store.add(c.scope, scopeCwd, {
        text: c.text,
        quote: c.quote,
        ...(id ? { session: id } : {}),
        ...(message ? { message } : {}),
        origin: "auto",
        kind: c.kind,
        replace: c.op === "supersede",
      });
      if (result.ok) {
        applied.set(c, result.replaced ? "replaced" : "added");
        noticed.push({ scope: c.scope, entry: result.entry });
        if (result.replaced)
          updated = {
            opId: result.opId,
            scope: c.scope,
            before: result.replaced,
            after: result.entry,
          };
      } else applied.set(c, result.reason === "duplicate" ? "reinforced" : result.reason);
    }
    // One card per run (≤3 changes): a lone replacement — «Обновил» with «Вернуть»; anything else — one
    // «Заметил и запомнил» / «Запомнил N» (a replaced entry's «Вернуть» is in «Было»).
    if (updated && noticed.length === 1)
      await options.note?.(
        MEMORY_CARD.updated,
        MEMORY_TEXT.updated(updated.before.text, updated.after.text),
        { ...updatedDetails(updated.opId, updated.scope, updated.before, updated.after) },
      );
    else if (noticed.length)
      await options.note?.(
        MEMORY_CARD.auto,
        noticed.length === 1
          ? MEMORY_TEXT.noticed(noticed[0]!.entry.text)
          : MEMORY_TEXT.noticedMany(noticed.length),
        { ...autoDetails(noticed) },
      );
  }
  if (candidates.length) {
    store.recordCandidates(
      candidates.map((c) => ({
        session,
        model: options.model,
        op: c.op,
        scope: c.scope,
        kind: c.kind,
        text: c.text,
        quote: c.quote,
        verdict: c.verdict,
        ...(c.target ? { target: c.target } : {}),
        ...(applied.has(c) ? { applied: applied.get(c) } : {}),
      })),
    );
  }
  if (!call.error && input.watermark) saveWatermark(dir, session, input.watermark, ts);
  return finish({
    ...base,
    ok: !call.error,
    status: call.status,
    input: call.input,
    output: call.output,
    costUsd: call.error ? null : call.costUsd,
    json: ops !== undefined,
    messages: input.messages.length,
    signals: selected.length,
    ops: ops?.length ?? 0,
    accepted: candidates.filter((c) => c.verdict === "ok").length,
    ...(options.write
      ? { written: [...applied.values()].filter((v) => v === "added" || v === "replaced").length }
      : {}),
    ...(call.error ? { error: call.error } : {}),
  });
}

/** Session files under `dir`, newest first. */
function sessionFiles(dir: string): { path: string; mtime: number }[] {
  try {
    return readdirSync(dir, { recursive: true })
      .map(String)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => {
        const path = join(dir, name);
        return { path, mtime: statSync(path).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}

export type ExtractorMode = "probe" | "shadow" | "write" | "off";

type CardNote = (
  customType: string,
  text: string,
  details: Record<string, unknown>,
) => Promise<void>;

/** No more than this many memory cards in the chat per rolling hour (the rest is written quietly). */
export const MEMORY_CARDS_PER_HOUR = 3;

/**
 * The chat must not turn into a feed of «Запомнил…»: at most MEMORY_CARDS_PER_HOUR cards an hour.
 * Over the cap the entries are still written (they are in «Память» with «Вернуть»); the next card that
 * gets through says how many were not announced.
 */
export function limitMemoryCards(
  note: CardNote,
  options: { perHour?: number; now?: () => number } = {},
): CardNote {
  const perHour = options.perHour ?? MEMORY_CARDS_PER_HOUR;
  const now = options.now ?? Date.now;
  const shown: number[] = [];
  let unannounced = 0;
  return async (customType, text, details) => {
    const t = now();
    while (shown.length && t - shown[0]! > 3_600_000) shown.shift();
    const items = Array.isArray(details.items) ? details.items.length : 1;
    if (shown.length >= perHour) {
      unannounced += items;
      return;
    }
    shown.push(t);
    const more = unannounced;
    unannounced = 0;
    await note(
      customType,
      more ? `${text} (и ещё ${more} — в настройках «Память»)` : text,
      more ? { ...details, unannounced: more } : details,
    );
  };
}

/**
 * PRSLOY_MEMORY_EXTRACTOR wins (probe / shadow / write / off, owner and developer builds);
 * otherwise memory on with `autoMemory` "shadow" → shadow, `true` → write (M-3b: accepted
 * candidates go into the memory with a card in the open chat).
 */
export function extractorMode(
  env: string | undefined,
  flags: { memory: boolean; autoMemory: "off" | "shadow" | true },
): ExtractorMode {
  if (env === "probe" || env === "shadow" || env === "write" || env === "off") return env;
  if (!flags.memory || flags.autoMemory === "off") return "off";
  return flags.autoMemory === true ? "write" : "shadow";
}

/**
 * The queue: one call at a time. Probe: each session once per app run. Shadow: each time the
 * user leaves a chat (the watermark keeps it to new words), plus a catch-up of ≤2 sessions at
 * start. The mode is read on every event, so the owner's flag needs no restart.
 */
export function installMemoryExtractor(options: {
  mode: () => ExtractorMode;
  agentDir: string;
  learningDir?: string;
  baseUrl: () => string;
  apiKey: () => string | undefined;
  availableModels: () => readonly string[] | undefined;
  fetch: FetchLike;
  /** Model override (tests). */
  model?: string | undefined;
  onRun?: (run: ExtractorRun) => void;
  /** Cards in the open chat (write mode). */
  note?: (customType: string, text: string, details: Record<string, unknown>) => Promise<void>;
  /** Catch-up at start (shadow): delay, how many; `false` — none. */
  catchUp?: { delayMs: number; max: number; quietMs?: number } | false;
}): { stop(): void; idle(): Promise<void> } {
  const probed = new Set<string>();
  const queued = new Set<string>();
  const note = options.note ? limitMemoryCards(options.note) : undefined;
  let chain: Promise<void> = Promise.resolve();
  const learningDir =
    options.learningDir ??
    process.env.PRSLOY_LEARN_DIR ??
    join(options.agentDir, "prsloy-learning");
  const enqueue = (sessionFile: string) => {
    const mode = options.mode();
    if (mode === "off") return;
    if (mode === "probe") {
      if (probed.has(sessionFile)) return;
      probed.add(sessionFile);
    } else if (queued.has(sessionFile)) return;
    queued.add(sessionFile);
    chain = chain.then(async () => {
      try {
        const apiKey = options.apiKey();
        if (!apiKey) return;
        const common = {
          baseUrl: options.baseUrl(),
          apiKey,
          model: options.model ?? extractorModel(options.availableModels()),
          sessionFile,
          fetch: options.fetch,
        };
        const run =
          mode === "probe"
            ? await runExtractorProbe({ ...common, journalDir: memoryDirFor(options.agentDir) })
            : await runExtractorShadow({
                ...common,
                agentDir: options.agentDir,
                learningDir,
                write: mode === "write",
                ...(note ? { note } : {}),
              });
        options.onRun?.(run);
      } catch (error) {
        console.warn("[prsloy] memory extractor failed:", error);
      } finally {
        queued.delete(sessionFile);
      }
    });
  };
  const stop = onSessionLeft(enqueue);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const catchUp = options.catchUp ?? { delayMs: 30_000, max: 2 };
  if (catchUp) {
    timer = setTimeout(() => {
      const mode = options.mode();
      if (mode !== "shadow" && mode !== "write") return;
      const quiet = catchUp.quietMs ?? 60_000;
      let n = 0;
      for (const file of sessionFiles(join(options.agentDir, "sessions"))) {
        if (n >= catchUp.max) break;
        // Still being written: it will come with «session left».
        if (Date.now() - file.mtime < quiet) continue;
        if (!sessionHasSignal(options.agentDir, file.path)) continue;
        n += 1;
        enqueue(file.path);
      }
    }, catchUp.delayMs);
    timer.unref?.();
  }
  return {
    stop: () => {
      stop();
      if (timer) clearTimeout(timer);
    },
    idle: async () => {
      // Chained runs may add more while we wait.
      let last: Promise<void> | undefined;
      while (last !== chain) {
        last = chain;
        await chain;
      }
    },
  };
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
