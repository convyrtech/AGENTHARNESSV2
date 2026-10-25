/**
 * PRSLOY IPC handlers (main side). Wired from index.ts with one call; all logic here.
 * Inputs from the renderer are untrusted: validate types and sizes.
 */
import type {
  PrsloyKeyResult,
  PrsloyState,
  PrsloyTurnSnapshot,
  PrsloyUndoResult,
} from "@zeno/contracts";
import { normalizePrsloyBaseUrl, PRSLOY_DEFAULT_BASE_URL } from "../../shared/prsloy-config.ts";
import type { PrsloyContext } from "./context.ts";
import { checkPrsloyKey, type FetchLike } from "./gateway-check.ts";
import { maskKey } from "./key-store.ts";
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
};

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
    harnessLoaded: ctx.harnessExtensions.length > 0,
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

export function registerPrsloyIpc(ipcMain: IpcMainLike, deps: PrsloyIpcDeps): void {
  const { ctx } = deps;
  const state = () => buildPrsloyState(ctx, deps.needsWorkspace());

  ipcMain.handle(PRSLOY_IPC.getState, () => state());

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
    if (key) {
      const check = await checkPrsloyKey({ baseUrl, apiKey: key, fetch: deps.fetch });
      if (!check.ok) return check;
      modelIds = check.modelIds;
    }
    ctx.setBaseUrl(baseUrl);
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
    return {
      restoredTo: toSnapshotView(result.restoredTo),
      ...(result.backup ? { backup: toSnapshotView(result.backup) } : {}),
      rewritten: result.rewritten,
      removed: result.removed,
    };
  });
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
