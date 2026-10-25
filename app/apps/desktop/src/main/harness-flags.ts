/**
 * The owner's switches for the PRSLOY harness: `prsloy-harness.json` in the agent folder
 * (`$PI_CODING_AGENT_DIR`). The harness reads it on every turn, so a change needs no restart.
 * Only known flags with the right type are accepted; other keys in the file are kept.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HarnessFlags } from "@zeno/contracts";
import { app, ipcMain, type IpcMainInvokeEvent } from "electron";

export const HARNESS_FLAGS_FILE = "prsloy-harness.json";

export function harnessFlagsPath(agentDir: string): string {
  return join(agentDir, HARNESS_FLAGS_FILE);
}

function readRaw(path: string): Record<string, unknown> {
  try {
    if (!existsSync(path)) return {};
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Missing file or flag: both are on — the second opinion and memory («Запоминать, когда я
 * прошу»; the agent stores only what the owner asked, research/18 §6.4). Off only when the
 * owner turned it off in Settings.
 */
export function readHarnessFlags(path: string): HarnessFlags {
  const raw = readRaw(path);
  return { secondOpinion: raw.secondOpinion !== false, memory: raw.memory !== false };
}

const FLAG_KEYS = ["secondOpinion", "memory"] as const;

/** Only known flags, only booleans, at least one; other keys in the file are kept. */
export function writeHarnessFlags(path: string, patch: unknown): HarnessFlags {
  if (!patch || typeof patch !== "object") throw new Error("flags must be an object");
  const raw = patch as Record<string, unknown>;
  const next: Record<string, boolean> = {};
  for (const key of FLAG_KEYS) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== "boolean") throw new Error(`${key} must be a boolean`);
    next[key] = raw[key];
  }
  if (Object.keys(next).length === 0) throw new Error("no known flag to set");
  const file = { ...readRaw(path), ...next };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`);
  renameSync(tmp, path);
  return readHarnessFlags(path);
}

/** Main exports `PI_CODING_AGENT_DIR` before app ready (prsloy/agent-home.ts). */
function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR?.trim() || join(app.getPath("userData"), "agent");
}

/**
 * The harness reads a missing `memory` as off; the app's default is on. Writes `memory: true`
 * once when the file has no such key, so the harness sees what Settings shows; an owner's
 * `false` stays.
 */
export function ensureMemoryDefault(path: string): void {
  if (readRaw(path).memory !== undefined) return;
  try {
    writeHarnessFlags(path, { memory: true });
  } catch {
    // Read-only agent folder: Settings still shows on, the harness keeps its own default.
  }
}

export function installHarnessFlags(
  assertTrustedSender: (event: IpcMainInvokeEvent) => void,
): void {
  ensureMemoryDefault(harnessFlagsPath(agentDir()));
  ipcMain.handle("prsloy:harness-flags:get", (event) => {
    assertTrustedSender(event);
    return readHarnessFlags(harnessFlagsPath(agentDir()));
  });
  ipcMain.handle("prsloy:harness-flags:set", (event, patch: unknown) => {
    assertTrustedSender(event);
    return writeHarnessFlags(harnessFlagsPath(agentDir()), patch);
  });
}
