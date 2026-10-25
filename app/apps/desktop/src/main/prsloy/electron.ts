/**
 * Electron glue for PRSLOY: builds the context from app paths + managed runtimes.
 * index.ts calls `initPrsloy()` right after the bundled runtimes are configured and
 * before any Agent Host spawn.
 */
import { app, net, safeStorage } from "electron";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  getActiveBundledRuntimeRoots,
  getActiveBundledRuntimeStatus,
} from "../bundled-runtimes.ts";
import { bootstrapPrsloy, pickPythonExecutable, type PrsloyContext } from "./context.ts";
import type { FetchLike } from "./gateway-check.ts";

export function initPrsloy(mainModuleUrl: string): PrsloyContext {
  let userDataPath: string;
  try {
    userDataPath = app.getPath("userData");
  } catch {
    userDataPath = join(homedir(), ".prsloy-fallback");
  }
  const status = getActiveBundledRuntimeStatus();
  const roots = getActiveBundledRuntimeRoots();
  const ctx = bootstrapPrsloy({
    userDataPath,
    resourcesPath: typeof process.resourcesPath === "string" ? process.resourcesPath : undefined,
    mainModuleUrl,
    runtimesRoot: roots?.root,
    pythonExecutable: pickPythonExecutable({
      platform: process.platform,
      pythonVenv: status.pythonVenv,
      bundledPython: status.python?.path,
    }),
    cipher: safeStorage,
  });
  console.log(
    `[prsloy] agent home ${ctx.agentDir}; harness ${ctx.harnessEnabled ? "on" : "off"}` +
      (ctx.shellPath ? `; shell ${ctx.shellPath} (${ctx.shellSource})` : ""),
  );
  return ctx;
}

/** Gateway checks go through Chromium's network stack (system proxy, OS cert store). */
export const electronFetch: FetchLike = (input, init) => net.fetch(input, init);
