/**
 * After the settings handler wrote the harness flags (harness-flags.ts): who needs to react.
 * Memory erases itself when turned off (memory-ipc.ts); the host restarts when web tools are
 * switched, so the search keys reach it (ipc.ts). No Electron here: tested with plain functions.
 */
import type { HarnessFlags } from "@zeno/contracts";

type Listener = (before: HarnessFlags, after: HarnessFlags) => Promise<void> | void;

const listeners = new Map<string, Listener>();

/** One listener per name: registering again (a new IPC setup) replaces the old one. */
export function onHarnessFlagsChanged(name: string, listener: Listener): void {
  listeners.set(name, listener);
}

export async function harnessFlagsChanged(
  before: HarnessFlags,
  after: HarnessFlags,
): Promise<void> {
  for (const [name, listener] of listeners) {
    try {
      await listener(before, after);
    } catch (error) {
      console.warn(`[prsloy] reacting to the flags (${name}) failed:`, error);
    }
  }
}
