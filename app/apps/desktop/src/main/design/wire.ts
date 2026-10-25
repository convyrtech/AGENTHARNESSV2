/**
 * The only surface index.ts touches: resolves bundle, runtimes and gateway defaults,
 * then registers the design service.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { app, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import {
  getActiveBundledNodeExecutable,
  getActiveBundledRuntimeRoots,
  getBundledPythonExecutable,
} from "../bundled-runtimes.ts";
import type { PrsloyContext } from "../prsloy/context.ts";
import { type DesignGateway, type DesignService, registerDesignIpc } from "./service.ts";

const DEFAULT_BASE_URL = "https://api.prsloy.online/v1";

/** Packaged: Resources/design. Dev: DESIGN_BUNDLE_DIR or apps/desktop/design-bundle. */
export function resolveDesignBundle(mainDir: string): string {
  if (process.env.DESIGN_BUNDLE_DIR) return process.env.DESIGN_BUNDLE_DIR;
  if (app.isPackaged && typeof process.resourcesPath === "string") {
    return join(process.resourcesPath, "design");
  }
  // dist/main → apps/desktop
  return join(mainDir, "..", "..", "design-bundle");
}

/** Env fallback until the provider settings hand over their key (PRSLOY_API_KEY / PRSLOY_BASE_URL). */
export function envGateway(): DesignGateway | undefined {
  const apiKey = process.env.PRSLOY_API_KEY?.trim();
  if (!apiKey) return undefined;
  return { apiKey, baseUrl: process.env.PRSLOY_BASE_URL?.trim() || DEFAULT_BASE_URL };
}

/** The owner's PRSLOY key and endpoint from the provider settings; env fallback for dev and tests. */
export function prsloyGateway(prsloy: PrsloyContext): DesignGateway | undefined {
  const apiKey = prsloy.keyStore.read();
  return apiKey ? { apiKey, baseUrl: prsloy.getState().baseUrl } : envGateway();
}

export function installDesign(
  mainDir: string,
  getWindow: () => BrowserWindow | undefined,
  assertTrustedSender: (event: IpcMainInvokeEvent) => void,
  piCliPath: () => Promise<string | undefined>,
  prsloy: PrsloyContext,
): DesignService {
  const getGateway = () => prsloyGateway(prsloy);
  return registerDesignIpc({
    piSettings: () => (prsloy.shellPath ? { shellPath: prsloy.shellPath } : {}),
    piToolsDir: join(prsloy.agentDir, "bin"),
    userDataPath: app.getPath("userData"),
    bundleRoot: resolveDesignBundle(mainDir),
    // PRSLOY_DESIGN_HOME: tests put the no-project workspace under a Cyrillic profile folder
    fallbackRoot: process.env.PRSLOY_DESIGN_HOME || join(app.getPath("documents"), "PRSLOY"),
    getWindow,
    assertTrustedSender,
    piCliPath,
    getGateway,
    basePython: () => {
      const bundled = getBundledPythonExecutable(getActiveBundledRuntimeRoots()?.pythonRoot);
      if (bundled && existsSync(bundled)) return bundled;
      return process.platform === "win32" ? "python" : "python3";
    },
    nodeExecutable: () => getActiveBundledNodeExecutable() ?? "node",
    gitBinary: () => prsloy.gitBinary(),
    // <pi agent dir>/prsloy-learning (%APPDATA%\\PRSLOY\\agent\\prsloy-learning), next to the «Код» harness's events
    learnDir: join(prsloy.agentDir, "prsloy-learning"),
  });
}
