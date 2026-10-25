/**
 * PRSLOY IPC handlers (main side). Wired from index.ts with one call; all logic here.
 * Inputs from the renderer are untrusted: validate types and sizes.
 */
import { join } from "node:path";
import type {
  PrsloyKeyResult,
  PrsloyState,
  PrsloyTurnSnapshot,
  PrsloyUndoResult,
} from "@zeno/contracts";
import { readFlags } from "@prsloy/harness";
import { normalizePrsloyBaseUrl, PRSLOY_DEFAULT_BASE_URL } from "../../shared/prsloy-config.ts";
import type { PrsloyContext } from "./context.ts";
import { checkPrsloyKey, type FetchLike } from "./gateway-check.ts";
import { maskKey } from "./key-store.ts";
import { recordTurnUndo } from "./learning-undo.ts";
import { extractorMode, installMemoryExtractor, testProviderEndpoint } from "./memory-extractor.ts";
import { onHarnessFlagsChanged } from "./flags-events.ts";
import { registerPrsloyMemoryIpc } from "./memory-ipc.ts";
import { registerPrsloySearchIpc } from "./search-ipc.ts";
import { startPrsloyModelRefresh } from "./model-list.ts";
import type { TurnRecord } from "./turn-snapshots.ts";

export const PRSLOY_IPC = {
  getState: "prsloy:get-state",
  setKey: "prsloy:set-key",
  clearKey: "prsloy:clear-key",
  setBaseUrl: "prsloy:set-base-url",
  listTurns: "prsloy:list-turns",
  undoTurn: "prsloy:undo-turn",
} as const;

const MAX_KEY_LENGTH = 4096;
const MAX_URL_LENGTH = 2048;

export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

export type PrsloyIpcDeps = {
  ctx: PrsloyContext;
  fetch: FetchLike;
  /** Recycle the Agent Host so it picks up the new key / URL. */
  restartHost(): Promise<void>;
  getWorkspace(): string | undefined;
  needsWorkspace(): boolean;
  isAgentBusy(): boolean;
  /** Tell the model (next turn) what an undo changed; best effort. */
  appendSessionNote?(
    customType: string,
    text: string,
    details?: Record<string, unknown>,
  ): Promise<void>;
  /** models.json changed (the gateway's model list): the host reloads its catalog. */
  onModelsChanged?(): Promise<void>;
  /** Startup + hourly `/v1/models` refresh; off in unit tests that don't want it. */
  refreshModels?: boolean;
  /** Only the main window's top frame may call these (as the other IPC in main/index.ts). */
  isTrustedSender?(event: unknown): boolean;
};

export const UNDO_NOTE_CUSTOM_TYPE = "prsloy.undo";

/**
 * What the model reads after «Откатить ход»: without it the next turn still "remembers"
 * files from the undone turn (live test: it re-created hello.py).
 */
export function undoNoteText(result: {
  restoredTo: { turn: number };
  removed: string[];
  rewritten: string[];
}): string {
  const list = (paths: string[]) =>
    paths.length > 20
      ? `${paths.slice(0, 20).join(", ")} и ещё ${paths.length - 20}`
      : paths.join(", ");
  const lines = [
    `Файлы хода ${result.restoredTo.turn} откачены: папка проекта возвращена к состоянию до этого хода.`,
  ];
  if (result.removed.length > 0) lines.push(`Удалены: ${list(result.removed)}.`);
  if (result.rewritten.length > 0)
    lines.push(`Возвращены к прежнему виду: ${list(result.rewritten)}.`);
  lines.push(
    "Изменения из этого и следующих ходов больше не действуют. Не опирайся на них: перед работой с этими файлами прочитай их заново.",
  );
  return lines.join("\n");
}

export function buildPrsloyState(ctx: PrsloyContext, needsWorkspace: boolean): PrsloyState {
  const key = ctx.keyStore.read();
  return {
    hasKey: Boolean(key),
    keyMemoryOnly: ctx.keyStore.isMemoryOnly(),
    maskedKey: maskKey(key),
    baseUrl: ctx.getState().baseUrl,
    defaultBaseUrl: PRSLOY_DEFAULT_BASE_URL,
    needsWorkspace,
    ...(ctx.shellSource ? { shellSource: ctx.shellSource } : {}),
    harnessLoaded: ctx.harnessEnabled,
    gitSetup: (({ status, percent }) => (percent === undefined ? { status } : { status, percent }))(
      ctx.git.state(),
    ),
    appSetup: ctx.setupProgress(),
    firstRunBypass:
      process.env.ZENO_ENABLE_TEST_COMMANDS === "1" && process.env.PRSLOY_FORCE_FIRST_RUN !== "1",
  };
}

function toSnapshotView(record: TurnRecord): PrsloyTurnSnapshot {
  return {
    id: record.id,
    turn: record.turn,
    createdAt: record.createdAt,
    kind: record.kind,
    ...(record.sessionId ? { sessionId: record.sessionId } : {}),
    ...(record.prompt ? { prompt: record.prompt } : {}),
  };
}

export function registerPrsloyIpc(rawIpcMain: IpcMainLike, deps: PrsloyIpcDeps): void {
  const { ctx } = deps;
  const ipcMain: IpcMainLike = {
    handle(channel, listener) {
      rawIpcMain.handle(channel, (event, ...args) => {
        if (deps.isTrustedSender && !deps.isTrustedSender(event)) {
          throw new Error("Untrusted IPC sender");
        }
        return listener(event, ...args);
      });
    },
  };
  const state = () => buildPrsloyState(ctx, deps.needsWorkspace());

  ipcMain.handle(PRSLOY_IPC.getState, () => state());

  registerPrsloySearchIpc(ipcMain, {
    settings: ctx.search,
    gatewayKey: () => ctx.keyStore.read(),
    gatewayUrl: () => ctx.getState().baseUrl,
    isAgentBusy: () => deps.isAgentBusy(),
    restartHost: () => deps.restartHost(),
    fetch: deps.fetch as typeof fetch,
  });

  // Web tools switched in the settings: the search keys go to the host only at its start
  // (shared/host-handoff.ts), so an idle host restarts; a running turn gets them next start.
  onHarnessFlagsChanged("web-tools", async (before, after) => {
    if (before.webTools === after.webTools || deps.isAgentBusy()) return;
    await deps.restartHost();
  });

  registerPrsloyMemoryIpc(ipcMain, {
    agentDir: ctx.agentDir,
    getWorkspace: () => deps.getWorkspace(),
    appendSessionNote: async (customType, text, details) =>
      deps.appendSessionNote?.(customType, text, details),
  });

  // M-sp: memory extractor outside the turn, after the user leaves a chat (off by default).
  const testEndpoint = () =>
    testProviderEndpoint(ctx.agentDir, process.env.PRSLOY_MEMORY_EXTRACTOR_PROVIDER);
  installMemoryExtractor({
    mode: () =>
      extractorMode(
        process.env.PRSLOY_MEMORY_EXTRACTOR,
        readFlags(join(ctx.agentDir, "prsloy-harness.json")),
      ),
    agentDir: ctx.agentDir,
    baseUrl: () => testEndpoint()?.baseUrl ?? ctx.getState().baseUrl,
    apiKey: () => testEndpoint()?.apiKey ?? ctx.keyStore.read(),
    availableModels: () => ctx.availableModels(),
    fetch: deps.fetch,
    model: process.env.PRSLOY_MEMORY_EXTRACTOR_MODEL,
    note: async (customType, text, details) => deps.appendSessionNote?.(customType, text, details),
  });

  if (deps.refreshModels !== false) {
    startPrsloyModelRefresh({
      ctx,
      fetch: deps.fetch,
      onChanged: () => deps.onModelsChanged?.(),
    });
  }

  ipcMain.handle(
    PRSLOY_IPC.setKey,
    async (_event, rawKey, rawBaseUrl): Promise<PrsloyKeyResult> => {
      if (typeof rawKey !== "string" || rawKey.length > MAX_KEY_LENGTH) {
        return { ok: false, code: "invalid_key" };
      }
      const key = rawKey.trim();
      let baseUrl = ctx.getState().baseUrl;
      if (rawBaseUrl !== undefined && rawBaseUrl !== null && rawBaseUrl !== "") {
        if (typeof rawBaseUrl !== "string" || rawBaseUrl.length > MAX_URL_LENGTH) {
          return { ok: false, code: "bad_url" };
        }
        const normalized = normalizePrsloyBaseUrl(rawBaseUrl);
        if (!normalized) return { ok: false, code: "bad_url" };
        baseUrl = normalized;
      }
      const check = await checkPrsloyKey({ baseUrl, apiKey: key, fetch: deps.fetch });
      if (!check.ok) return check;
      if (baseUrl !== ctx.getState().baseUrl) ctx.setBaseUrl(baseUrl);
      if (check.via === "models") ctx.setAvailableModels(check.modelIds);
      ctx.keyStore.write(key);
      await deps.restartHost();
      return { ok: true, state: state(), modelIds: check.modelIds };
    },
  );

  ipcMain.handle(PRSLOY_IPC.clearKey, async () => {
    ctx.keyStore.clear();
    await deps.restartHost();
    return state();
  });

  ipcMain.handle(PRSLOY_IPC.setBaseUrl, async (_event, rawBaseUrl): Promise<PrsloyKeyResult> => {
    if (typeof rawBaseUrl !== "string" || rawBaseUrl.length > MAX_URL_LENGTH) {
      return { ok: false, code: "bad_url" };
    }
    const baseUrl = normalizePrsloyBaseUrl(rawBaseUrl);
    if (!baseUrl) return { ok: false, code: "bad_url" };
    const key = ctx.keyStore.read();
    let modelIds: string[] = [];
    let listed = false;
    if (key) {
      const check = await checkPrsloyKey({ baseUrl, apiKey: key, fetch: deps.fetch });
      if (!check.ok) return check;
      modelIds = check.modelIds;
      listed = check.via === "models";
    }
    ctx.setBaseUrl(baseUrl);
    if (listed) ctx.setAvailableModels(modelIds);
    await deps.restartHost();
    return { ok: true, state: state(), modelIds };
  });

  ipcMain.handle(PRSLOY_IPC.listTurns, async (_event, rawOptions) => {
    const workspace = deps.getWorkspace();
    if (!workspace) return [];
    const sessionId =
      rawOptions && typeof rawOptions === "object" && "sessionId" in rawOptions
        ? (rawOptions as { sessionId?: unknown }).sessionId
        : undefined;
    const records = await ctx.snapshots.list(
      workspace,
      typeof sessionId === "string" && sessionId ? { sessionId } : {},
    );
    return records.map(toSnapshotView);
  });

  ipcMain.handle(PRSLOY_IPC.undoTurn, async (_event, rawId): Promise<PrsloyUndoResult> => {
    if (typeof rawId !== "string" || !/^[0-9a-f-]{36}$/u.test(rawId)) {
      throw new Error("Invalid snapshot id");
    }
    if (deps.isAgentBusy()) throw new Error("Stop the agent before undoing a turn");
    const workspace = deps.getWorkspace();
    if (!workspace) throw new Error("No workspace is open");
    const result = await ctx.snapshots.restore(workspace, rawId);
    // Same folder the harness writes to in the host (PRSLOY_LEARN_DIR or the agent home).
    recordTurnUndo(process.env.PRSLOY_LEARN_DIR ?? join(ctx.agentDir, "prsloy-learning"), {
      session: result.restoredTo.sessionId,
      workspace,
    });
    try {
      await deps.appendSessionNote?.(UNDO_NOTE_CUSTOM_TYPE, undoNoteText(result));
    } catch (error) {
      console.warn("[prsloy] undo note for the model failed:", error);
    }
    return {
      restoredTo: toSnapshotView(result.restoredTo),
      ...(result.backup ? { backup: toSnapshotView(result.backup) } : {}),
      rewritten: result.rewritten,
      removed: result.removed,
    };
  });
}

/**
 * Before an agent turn: wait (bounded) for PortableGit if it is still unpacking on first
 * launch (pi's bash needs it), then snapshot the workspace for «Откатить ход».
 */
export async function prepareTurn(
  ctx: PrsloyContext,
  workspace: string | undefined,
  meta: { prompt?: string; sessionId?: string },
): Promise<void> {
  // First launch: Node/Python and Git unpack in the background; the first turn waits.
  if (ctx.runtimes.state().status === "installing") await ctx.runtimes.whenReady(300_000);
  if (ctx.git.state().status === "installing") await ctx.git.whenReady(180_000);
  await snapshotBeforeTurn(ctx, workspace, meta);
}

/** Snapshot before an agent turn; bounded so a huge folder never delays the prompt long. */
export async function snapshotBeforeTurn(
  ctx: PrsloyContext,
  workspace: string | undefined,
  meta: { prompt?: string; sessionId?: string },
  budgetMs = 20_000,
): Promise<void> {
  if (!workspace) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      ctx.snapshots.beforeTurn(workspace, meta),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), budgetMs);
      }),
    ]);
    if (outcome === "timeout")
      console.warn("[prsloy] turn snapshot still running; prompt continues");
    else if (outcome.skipped) console.warn("[prsloy] turn snapshot skipped:", outcome.skipped);
  } catch (error) {
    console.warn("[prsloy] turn snapshot failed:", error);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
