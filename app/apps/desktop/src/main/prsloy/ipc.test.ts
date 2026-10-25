import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { PrsloyKeyResult, PrsloyState, PrsloyUndoResult } from "@zeno/contracts";
import { MockGatewayServer } from "../../../../../packages/test-utils/src/index.ts";
import { bootstrapPrsloy, type PrsloyContext } from "./context.ts";
import { PRSLOY_IPC, registerPrsloyIpc, snapshotBeforeTurn } from "./ipc.ts";
import type { SecretCipher } from "./key-store.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const cipher: SecretCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(text, "utf8").reverse(),
  decryptString: (buf) => Buffer.from(buf).reverse().toString("utf8"),
};

function fakeIpc() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  return {
    ipcMain: {
      handle: (channel: string, fn: (e: unknown, ...a: unknown[]) => unknown) =>
        handlers.set(channel, fn),
    },
    invoke: async <T>(channel: string, ...args: unknown[]) =>
      (await handlers.get(channel)!({}, ...args)) as T,
  };
}

async function setup() {
  const userData = tempDir("prsloy-ud-");
  const workspace = tempDir("prsloy-ws-");
  const server = new MockGatewayServer({
    apiKey: "sk-real",
    modelIds: ["deepseek-v4.1-flash-1017"],
  });
  await server.start();
  cleanups.push(() => server.stop());
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH };
  const ctx = bootstrapPrsloy({ userDataPath: userData, cipher, env, platform: "linux" });
  let restarts = 0;
  let busy = false;
  const notes: { customType: string; text: string }[] = [];
  let currentWorkspace: string | undefined;
  const { ipcMain, invoke } = fakeIpc();
  registerPrsloyIpc(ipcMain, {
    ctx,
    fetch,
    restartHost: async () => {
      restarts += 1;
    },
    getWorkspace: () => currentWorkspace,
    needsWorkspace: () => !currentWorkspace,
    isAgentBusy: () => busy,
    appendSessionNote: async (customType, text) => {
      notes.push({ customType, text });
    },
  });
  return {
    userData,
    workspace,
    server,
    env,
    ctx,
    invoke,
    restarts: () => restarts,
    notes,
    setBusy: (value: boolean) => (busy = value),
    openWorkspace: () => (currentWorkspace = workspace),
  };
}

describe("first run over IPC (mock gateway)", () => {
  it("bootstraps an isolated home and asks for a key, then a folder", async () => {
    const t = await setup();
    expect(t.env.PI_CODING_AGENT_DIR).toBe(join(t.userData, "agent"));
    const models = JSON.parse(readFileSync(join(t.userData, "agent", "models.json"), "utf8"));
    expect(models.providers.prsloy.baseUrl).toBe("https://api.prsloy.online/v1");
    // MCP migration runs once per userData.
    const prsloyState = JSON.parse(readFileSync(join(t.userData, "prsloy", "state.json"), "utf8"));
    expect(prsloyState.migrations).toEqual(["no-auto-mcp-adapter"]);
    const state = await t.invoke<PrsloyState>(PRSLOY_IPC.getState);
    expect(state).toMatchObject({ hasKey: false, needsWorkspace: true, harnessLoaded: true });
  });

  it("rejects a wrong key without storing it", async () => {
    const t = await setup();
    const result = await t.invoke<PrsloyKeyResult>(PRSLOY_IPC.setKey, "sk-wrong", t.server.baseUrl);
    expect(result).toEqual({ ok: false, code: "invalid_key", status: 401 });
    expect(t.ctx.keyStore.read()).toBeUndefined();
    expect(t.restarts()).toBe(0);
    // The URL is only saved together with a working key.
    expect(t.ctx.getState().baseUrl).toBe("https://api.prsloy.online/v1");
  });

  it("stores a good key encrypted, points pi at the gateway and restarts the host", async () => {
    const t = await setup();
    const result = await t.invoke<PrsloyKeyResult>(
      PRSLOY_IPC.setKey,
      " sk-real ",
      t.server.baseUrl,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state).toMatchObject({ hasKey: true, maskedKey: "…", baseUrl: t.server.baseUrl });
    expect(result.modelIds).toEqual(["deepseek-v4.1-flash-1017"]);
    expect(t.restarts()).toBe(1);
    const blob = readFileSync(join(t.userData, "prsloy", "gateway-key.bin"));
    expect(blob.toString("utf8")).not.toContain("sk-real");
    const models = JSON.parse(readFileSync(join(t.userData, "agent", "models.json"), "utf8"));
    expect(models.providers.prsloy.baseUrl).toBe(t.server.baseUrl);
    expect(JSON.stringify(models)).not.toContain("sk-real");
    // Host env carries the key only as the handoff var, never machine secrets.
    const hostEnv = t.ctx.hostEnv({ PATH: "/bin", GH_TOKEN: "ghp" });
    expect(hostEnv.PRSLOY_GATEWAY_KEY).toBe("sk-real");
    expect(hostEnv.GH_TOKEN).toBeUndefined();
  });

  it("maps a dead gateway to network and a bad URL to bad_url", async () => {
    const t = await setup();
    expect(
      await t.invoke<PrsloyKeyResult>(PRSLOY_IPC.setKey, "sk-real", "http://127.0.0.1:9/v1"),
    ).toMatchObject({ ok: false, code: "network" });
    expect(
      await t.invoke<PrsloyKeyResult>(PRSLOY_IPC.setKey, "sk-real", "http://evil.example/v1"),
    ).toEqual({
      ok: false,
      code: "bad_url",
    });
    expect(await t.invoke<PrsloyKeyResult>(PRSLOY_IPC.setKey, 42)).toEqual({
      ok: false,
      code: "invalid_key",
    });
  });

  it("changes the gateway URL only when the stored key works there", async () => {
    const t = await setup();
    await t.invoke(PRSLOY_IPC.setKey, "sk-real", t.server.baseUrl);
    const other = new MockGatewayServer({ apiKey: "sk-other" });
    await other.start();
    cleanups.push(() => other.stop());
    expect(await t.invoke<PrsloyKeyResult>(PRSLOY_IPC.setBaseUrl, other.baseUrl)).toMatchObject({
      ok: false,
      code: "invalid_key",
    });
    expect(t.ctx.getState().baseUrl).toBe(t.server.baseUrl);
    const cleared = await t.invoke<PrsloyState>(PRSLOY_IPC.clearKey);
    expect(cleared.hasKey).toBe(false);
    expect(await t.invoke<PrsloyKeyResult>(PRSLOY_IPC.setBaseUrl, other.baseUrl)).toMatchObject({
      ok: true,
    });
  });
});

describe("undo turn over IPC", () => {
  it("lists turns and restores the workspace; refuses while the agent runs", async () => {
    const t = await setup();
    t.openWorkspace();
    writeFileSync(join(t.workspace, "page.html"), "v1");
    await snapshotBeforeTurn(t.ctx, t.workspace, { prompt: "поправь страницу", sessionId: "s1" });
    writeFileSync(join(t.workspace, "page.html"), "v2");
    writeFileSync(join(t.workspace, "extra.css"), "body{}");

    const turns = await t.invoke<{ id: string; turn: number; prompt?: string }[]>(
      PRSLOY_IPC.listTurns,
      {
        sessionId: "s1",
      },
    );
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ turn: 1, prompt: "поправь страницу" });

    t.setBusy(true);
    await expect(t.invoke(PRSLOY_IPC.undoTurn, turns[0]!.id)).rejects.toThrow(/Stop the agent/);
    t.setBusy(false);
    await expect(t.invoke(PRSLOY_IPC.undoTurn, "../etc")).rejects.toThrow(/Invalid snapshot id/);

    const undo = await t.invoke<PrsloyUndoResult>(PRSLOY_IPC.undoTurn, turns[0]!.id);
    expect(undo.removed).toEqual(["extra.css"]);
    expect(readFileSync(join(t.workspace, "page.html"), "utf8")).toBe("v1");
    expect(existsSync(join(t.workspace, "extra.css"))).toBe(false);
    // The model is told on its next turn (it re-created undone files in the live test).
    expect(t.notes).toHaveLength(1);
    expect(t.notes[0]!.customType).toBe("prsloy.undo");
    expect(t.notes[0]!.text).toContain("Файлы хода 1 откачены");
    expect(t.notes[0]!.text).toContain("Удалены: extra.css.");
    expect(t.notes[0]!.text).toContain("Возвращены к прежнему виду: page.html.");
  });
});

export type { PrsloyContext };
