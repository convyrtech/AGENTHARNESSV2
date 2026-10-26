/**
 * The owner's switches for the PRSLOY harness: `prsloy-harness.json` in the agent folder
 * (`$PI_CODING_AGENT_DIR`). The harness reads it on every turn, so a change needs no restart.
 * Only known flags with the right type are accepted; other keys in the file are kept.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HarnessFlags } from "@zeno/contracts";
import { app, ipcMain, type IpcMainInvokeEvent } from "electron";
import { harnessFlagsChanged } from "./prsloy/flags-events.ts";

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
 * Missing file or flag: the second opinion, memory, auto memory and web tools are on (MVP
 * defaults since 25.10, owner's call; research/24 §3, #23); the honesty checks are off until
 * turned on. A value the user wrote (memory: false, autoMemory: "off", webTools: false) stays:
 * users of alpha.1 have no such keys, so they get the new defaults.
 */
export function readHarnessFlags(path: string): HarnessFlags {
  const raw = readRaw(path);
  const auto = raw.autoMemory;
  return {
    secondOpinion: raw.secondOpinion !== false,
    memory: raw.memory !== false,
    // research/24 §2 «трубы»: the harness reads the same keys (packages/prsloy-harness/src/flags.ts)
    autoMemory: auto === "off" || auto === "shadow" ? auto : true,
    honestExit: raw.honestExit === true,
    // #25: on by default; a hand-set false stays.
    testGuard: raw.testGuard !== false,
    claimCheck: raw.claimCheck === true,
    webTools: raw.webTools !== false,
    testQuality: raw.testQuality === true,
    reviewerCheats: raw.reviewerCheats === true,
  };
}

const FLAG_KEYS = [
  "secondOpinion",
  "memory",
  "honestExit",
  "testGuard",
  "claimCheck",
  "webTools",
  "testQuality",
  "reviewerCheats",
] as const;
/** Not a boolean: `autoMemory` is "off" | "shadow" | true. */
const AUTO_MEMORY_VALUES: readonly unknown[] = ["off", "shadow", true];

/** Only known flags with the right type, at least one; other keys in the file are kept. */
export function writeHarnessFlags(path: string, patch: unknown): HarnessFlags {
  if (!patch || typeof patch !== "object") throw new Error("flags must be an object");
  const raw = patch as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const key of FLAG_KEYS) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== "boolean") throw new Error(`${key} must be a boolean`);
    next[key] = raw[key];
  }
  if (raw.autoMemory !== undefined) {
    if (!AUTO_MEMORY_VALUES.includes(raw.autoMemory))
      throw new Error('autoMemory must be "off", "shadow" or true');
    next.autoMemory = raw.autoMemory;
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

export function installHarnessFlags(
  assertTrustedSender: (event: IpcMainInvokeEvent) => void,
): void {
  ipcMain.handle("prsloy:harness-flags:get", (event) => {
    assertTrustedSender(event);
    return readHarnessFlags(harnessFlagsPath(agentDir()));
  });
  ipcMain.handle("prsloy:harness-flags:set", async (event, patch: unknown) => {
    assertTrustedSender(event);
    const path = harnessFlagsPath(agentDir());
    const before = readHarnessFlags(path);
    const after = writeHarnessFlags(path, patch);
    // research/24 §3.6: turning memory off erases it; web tools on/off restarts an idle host.
    await harnessFlagsChanged(before, after);
    return after;
  });
}
