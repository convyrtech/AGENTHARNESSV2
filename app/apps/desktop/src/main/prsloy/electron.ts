/**
 * Electron glue for PRSLOY: builds the context from app paths + managed runtimes.
 * index.ts calls `initPrsloy()` right after the bundled runtimes are configured and
 * before any Agent Host spawn.
 */
import { app, net, safeStorage, utilityProcess, type UtilityProcess } from "electron";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  getActiveBundledRuntimeRoots,
  getActiveBundledRuntimeStatus,
} from "../bundled-runtimes.ts";
import { resolveVendorRuntimeLayout } from "../runtime-provision.ts";
import { splitHostHandoff } from "./agent-env.ts";
import { bootstrapPrsloy, pickPythonExecutable, type PrsloyContext } from "./context.ts";
import type { FetchLike } from "./gateway-check.ts";
import type { RuntimeBoot } from "./runtime-boot.ts";

/** `[prsloy-timing] <phase> <ms since process start>`; packaged-smoke reads these lines. */
export function logStartupTiming(phase: string): void {
  console.log(`[prsloy-timing] ${phase} ${Math.round(performance.now())}`);
}

function currentPythonExecutable(): string | undefined {
  const status = getActiveBundledRuntimeStatus();
  return pickPythonExecutable({
    platform: process.platform,
    pythonVenv: status.pythonVenv,
    bundledPython: status.python?.path,
  });
}

export function initPrsloy(mainModuleUrl: string, runtimes?: RuntimeBoot): PrsloyContext {
  let userDataPath: string;
  try {
    userDataPath = app.getPath("userData");
  } catch {
    userDataPath = join(homedir(), ".prsloy-fallback");
  }
  const roots = getActiveBundledRuntimeRoots();
  const resourcesPath =
    typeof process.resourcesPath === "string" ? process.resourcesPath : undefined;
  const vendor = resolveVendorRuntimeLayout({
    ...(resourcesPath ? { resourcesPath } : {}),
    mainModuleUrl,
  });
  const ctx = bootstrapPrsloy({
    userDataPath,
    resourcesPath,
    mainModuleUrl,
    runtimesRoot: roots?.root,
    pythonExecutable: currentPythonExecutable(),
    cipher: safeStorage,
    ...(runtimes ? { runtimes } : {}),
    ...(resourcesPath ? { installerGitDir: join(resourcesPath, "runtimes", "git") } : {}),
    ...(vendor?.archives?.git
      ? {
          gitArchive: {
            path: vendor.archives.git,
            version: vendor.archives.manifest.git,
            files: vendor.archives.manifest.gitFiles,
          },
        }
      : {}),
    onGitSetup: (state) => {
      if (state.status !== "installing")
        console.log(`[prsloy] PortableGit: ${state.status}`, state.error ?? "");
    },
  });
  // Node/Python unpacked after the window: re-point python shims and rg/fd.
  runtimes?.onChange((state) => {
    if (state.status === "ready") ctx.refreshRuntimes(currentPythonExecutable());
    else if (state.status === "failed") console.warn("[prsloy] runtimes failed:", state.error);
  });
  // Unpack PortableGit in the background on first launch; the first turn waits for it.
  void ctx.git.ensure();
  console.log(
    `[prsloy] agent home ${ctx.agentDir}; harness ${ctx.harnessEnabled ? "on" : "off"}` +
      (ctx.shellPath ? `; shell ${ctx.shellPath} (${ctx.shellSource})` : ""),
  );
  return ctx;
}

/** Gateway checks go through Chromium's network stack (system proxy, OS cert store). */
export const electronFetch: FetchLike = (input, init) => net.fetch(input, init);

/**
 * Fork the Agent Host without secrets in its env: the gateway key and the search config go as
 * the first parentPort message (shared/host-handoff.ts), queued before any command main sends.
 */
export function forkAgentHost(
  entry: string,
  options: { env: Record<string, string>; serviceName: string; stdio: "pipe" },
): UtilityProcess {
  const { env, handoff } = splitHostHandoff(options.env);
  const child = utilityProcess.fork(entry, [], { ...options, env });
  child.postMessage(handoff);
  return child;
}
