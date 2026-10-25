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

/** Missing file or flag means on: the second opinion is a default, not an opt-in. */
export function readHarnessFlags(path: string): HarnessFlags {
  return { secondOpinion: readRaw(path).secondOpinion !== false };
}

export function writeHarnessFlags(path: string, patch: unknown): HarnessFlags {
  const value = (patch as { secondOpinion?: unknown } | null)?.secondOpinion;
  if (typeof value !== "boolean") throw new Error("secondOpinion must be a boolean");
  const next = { ...readRaw(path), secondOpinion: value };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
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
  ipcMain.handle("prsloy:harness-flags:set", (event, patch: unknown) => {
    assertTrustedSender(event);
    return writeHarnessFlags(harnessFlagsPath(agentDir()), patch);
  });
}
