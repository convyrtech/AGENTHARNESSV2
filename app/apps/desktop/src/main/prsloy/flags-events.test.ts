/**
 * Reacting to the harness flags (flags-events.ts): web tools switched → an idle host restarts so
 * the search keys reach it (shared/host-handoff.ts); a busy one gets them at its next start.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { HarnessFlags } from "@zeno/contracts";
import { bootstrapPrsloy } from "./context.ts";
import { harnessFlagsChanged } from "./flags-events.ts";
import { registerPrsloyIpc } from "./ipc.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

const FLAGS: HarnessFlags = {
  secondOpinion: true,
  memory: false,
  autoMemory: "off",
  honestExit: false,
  testGuard: false,
  claimCheck: false,
  webTools: false,
  testQuality: false,
  reviewerCheats: false,
  staleDocs: "end",
};

function setup(busy: { value: boolean }) {
  const userDataPath = mkdtempSync(join(tmpdir(), "prsloy-flags-"));
  cleanups.push(() => rmSync(userDataPath, { recursive: true, force: true }));
  const ctx = bootstrapPrsloy({
    userDataPath,
    cipher: {
      isEncryptionAvailable: () => true,
      encryptString: (t) => Buffer.from(t),
      decryptString: (b) => b.toString(),
    },
    env: {},
    platform: "linux",
  });
  const restarts: number[] = [];
  registerPrsloyIpc(
    { handle: () => undefined },
    {
      ctx,
      fetch,
      restartHost: async () => void restarts.push(Date.now()),
      getWorkspace: () => undefined,
      needsWorkspace: () => false,
      isAgentBusy: () => busy.value,
      refreshModels: false,
      isTrustedSender: () => true,
    },
  );
  return restarts;
}

describe("harness flags → host", () => {
  it("web tools on or off restarts an idle host, not a busy one, and nothing else does", async () => {
    const busy = { value: false };
    const restarts = setup(busy);
    await harnessFlagsChanged(FLAGS, { ...FLAGS, secondOpinion: false });
    expect(restarts).toHaveLength(0);
    await harnessFlagsChanged(FLAGS, { ...FLAGS, webTools: true });
    expect(restarts).toHaveLength(1);
    busy.value = true;
    await harnessFlagsChanged({ ...FLAGS, webTools: true }, FLAGS);
    expect(restarts).toHaveLength(1);
  });
});
