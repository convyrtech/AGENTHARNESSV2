import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
  type CreateAgentSessionFromServicesOptions,
  type ExtensionFactory,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { createWriteBoundary } from "./write-boundary.ts";

export type DelegatedWorkerModel = NonNullable<CreateAgentSessionFromServicesOptions["model"]>;
type EndMessage = Extract<AgentSessionEvent, { type: "message_end" }>["message"];
export type DelegatedWorkerAssistant = Extract<EndMessage, { role: "assistant" }>;

export interface DelegatedWorkerOptions {
  cwd: string;
  agentDir: string;
  modelRuntime: ModelRuntime;
  model: DelegatedWorkerModel;
  files: readonly string[];
  task: string;
  signal: AbortSignal;
  /** Throws to refuse a request. May return a replacement payload or undefined. */
  admit: (payload: unknown, model: DelegatedWorkerModel) => unknown;
  /** One notification per completed model response, including error/abort responses. */
  onUsage: (message: DelegatedWorkerAssistant) => void;
  maxRequests?: number;
  maxOutputTokens?: number;
}

export interface DelegatedWorkerResult {
  status: "completed" | "failed" | "cancelled";
  text: string;
  requests: number;
  error?: string;
}

const TOOLS = ["read", "edit", "write"];
const SYSTEM_PROMPT =
  "Implement this one scoped task. Use only the explicitly listed files. " +
  "You have read, edit and write; the host runs acceptance checks and independent review. " +
  "Do not claim tests passed. Return a short factual summary and any blocker.";

function key(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reject aliases instead of granting access to their targets. Rechecked before every tool. */
async function scopedPath(root: string, path: string): Promise<string> {
  if (!path || path.includes("\0")) throw new Error("Invalid worker file path");
  if (key(await realpath(root)) !== key(root)) throw new Error("Worker project root changed");
  const full = resolve(root, path);
  const rel = relative(root, full);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error("Worker file is outside the project");
  const parts = rel.split(sep);
  if (
    process.platform === "win32" &&
    parts.some(
      (part) =>
        /[:<>"|?*]|[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    )
  )
    throw new Error("Worker file uses a Windows path alias");
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = resolve(current, parts[index]!);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error("Worker files must not use symbolic links");
    if (index < parts.length - 1 && !stat.isDirectory())
      throw new Error("Worker file has a non-directory parent");
    if (index === parts.length - 1 && (!stat.isFile() || stat.nlink !== 1))
      throw new Error("Worker file must be a regular file without hard links");
    if (key(await realpath(current)) !== key(current))
      throw new Error("Worker file resolves through an alias");
  }
  return full;
}

function boundedPayload(payload: unknown, limit: number): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw new Error("Invalid worker provider payload");
  const result = { ...payload } as Record<string, unknown>;
  const field = "max_completion_tokens" in result ? "max_completion_tokens" : "max_tokens";
  const requested = result[field];
  result[field] =
    typeof requested === "number" && requested > 0 ? Math.min(Math.floor(requested), limit) : limit;
  return result;
}

/** One isolated SDK session. This result is NOT acceptance or review approval. */
export async function runDelegatedWorker(
  input: DelegatedWorkerOptions,
): Promise<DelegatedWorkerResult> {
  let requests = 0;
  let text = "";
  let failure: string | undefined;
  try {
    input.signal.throwIfAborted();
    if (input.model.api !== "openai-completions")
      throw new Error("Unsupported worker provider API");
    const maxRequests = Math.min(input.maxRequests ?? 12, 12);
    const maxOutputTokens = Math.min(input.maxOutputTokens ?? 8192, 8192, input.model.maxTokens);
    if (
      !Number.isInteger(maxRequests) ||
      maxRequests < 1 ||
      !Number.isInteger(maxOutputTokens) ||
      maxOutputTokens < 1
    )
      throw new Error("Invalid worker request limits");
    const cwd = await realpath(resolve(input.cwd));
    if (!input.files.length) throw new Error("Worker requires explicit files");
    const files = await Promise.all(input.files.map((path) => scopedPath(cwd, path)));
    const allowed = new Set(files.map(key));
    const scope: ExtensionFactory = (pi) => {
      pi.on("tool_call", async (event) => {
        try {
          if (failure) throw new Error(failure);
          const path = (event.input as Record<string, unknown>).path;
          if (!TOOLS.includes(event.toolName) || typeof path !== "string")
            throw new Error("Worker tool is outside its scope");
          if (!allowed.has(key(await scopedPath(cwd, path))))
            throw new Error("Worker file is outside its explicit scope");
          return undefined;
        } catch (error) {
          failure = message(error);
          return { block: true, terminate: true, reason: failure };
        }
      });
    };
    const settingsManager = SettingsManager.inMemory(
      {
        compaction: { enabled: false },
        retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
        cacheWarming: "off",
      },
      { projectTrusted: false },
    );
    const model = { ...input.model, maxTokens: maxOutputTokens };
    const runtime = await createAgentSessionRuntime(
      async ({ sessionManager }) => {
        const services = await createAgentSessionServices({
          cwd,
          agentDir: input.agentDir,
          settingsManager,
          modelRuntime: input.modelRuntime,
          resourceLoaderOptions: {
            noExtensions: true,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
            extensionFactories: [scope, createWriteBoundary({ agentDir: input.agentDir })],
            systemPrompt: SYSTEM_PROMPT,
            appendSystemPrompt: [],
            agentsFilesOverride: () => ({ agentsFiles: [] }),
          },
        });
        if (
          services.diagnostics.some((d) => d.type === "error") ||
          services.resourceLoader.getExtensions().errors.length
        )
          throw new Error("Worker resources failed to initialize");
        const created = await createAgentSessionFromServices({
          services,
          sessionManager,
          model,
          tools: TOOLS,
          excludeTools: ["delegate", "explore", "bash", "powershell"],
        });
        return { ...created, services, diagnostics: services.diagnostics };
      },
      { cwd, agentDir: input.agentDir, sessionManager: SessionManager.inMemory(cwd) },
    );
    const session = runtime.session;
    const abort = () => {
      session.agent.abort();
      session.abortBash();
      session.abortCompaction();
      session.abortBranchSummary();
    };
    let unsubscribe = () => {};
    try {
      await session.bindExtensions({
        mode: "rpc",
        onError: (error) => {
          failure = error.error;
          abort();
        },
      });
      if (
        failure ||
        session.getAllTools().some((t) => !TOOLS.includes(t.name)) ||
        session.getCallableToolNames().some((name) => !TOOLS.includes(name))
      )
        throw new Error(failure ?? "Unexpected worker tool");
      const previous = session.agent.onPayload;
      session.agent.onPayload = async (payload, requestModel) => {
        try {
          input.signal.throwIfAborted();
          if (failure) throw new Error(failure);
          if (requests >= maxRequests) throw new Error("Worker request limit reached");
          const transformed = previous ? await previous(payload, requestModel) : payload;
          const bounded = boundedPayload(
            transformed === undefined ? payload : transformed,
            maxOutputTokens,
          );
          const admitted = await input.admit(bounded, requestModel);
          input.signal.throwIfAborted();
          const finalPayload = boundedPayload(
            admitted === undefined ? bounded : admitted,
            maxOutputTokens,
          );
          requests++;
          return finalPayload;
        } catch (error) {
          failure = message(error);
          throw error;
        }
      };
      unsubscribe = session.subscribe((event) => {
        if (event.type !== "message_end" || event.message.role !== "assistant") return;
        const reply = event.message;
        text = reply.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        if (reply.stopReason === "error" || reply.stopReason === "aborted")
          failure ??= reply.errorMessage ?? reply.stopReason;
        try {
          input.onUsage(reply);
        } catch (error) {
          failure = message(error);
          abort();
        }
      });
      input.signal.addEventListener("abort", abort, { once: true });
      input.signal.throwIfAborted();
      await session.prompt(`${input.task}\n\nAllowed files:\n${files.join("\n")}`, {
        expandPromptTemplates: false,
      });
    } finally {
      input.signal.removeEventListener("abort", abort);
      abort();
      await session.abort();
      unsubscribe();
      await runtime.dispose();
    }
    if (input.signal.aborted) return { status: "cancelled", text, requests };
    if (failure) return { status: "failed", text, requests, error: failure };
    return { status: "completed", text, requests };
  } catch (error) {
    return {
      status: input.signal.aborted ? "cancelled" : "failed",
      text,
      requests,
      error: message(error),
    };
  }
}
