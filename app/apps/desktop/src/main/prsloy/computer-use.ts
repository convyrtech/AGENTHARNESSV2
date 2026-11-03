import { win32 } from "node:path";
import type { McpServerConfig } from "@zeno/contracts";

/**
 * The first computer-use backend we can evaluate without shipping a model or
 * installing a Windows service.  Keep this opt-in: agent-home deliberately
 * disables MCP for ordinary PRSLOY sessions.
 */
export const MUNIM_COMPUTER_USE_PACKAGE = "munim-computer-use@0.9.0";
export const MUNIM_COMPUTER_USE_VERSION = "0.9.0";

const WINDOWS_BINARY_RE = /(?:^|[\\/])munim-computer-use(?:\.exe)?$/iu;

export type ComputerUseServerOptions = {
  /** Use an already downloaded binary; no package manager or network needed. */
  binaryPath?: string;
  /** Keep the browser surface out of the desktop prototype. */
  browser?: boolean;
};

/**
 * Build the pi-compatible MCP entry without enabling it globally.
 *
 * `binaryPath` is intentionally explicit.  The npx fallback is useful for a
 * developer opt-in experiment, but it must never be silently installed by the
 * regular PRSLOY bootstrap.
 */
export function munimComputerUseServer(options: ComputerUseServerOptions = {}): McpServerConfig {
  const browser = options.browser === true;
  if (options.binaryPath !== undefined) {
    if (!win32.isAbsolute(options.binaryPath) || !WINDOWS_BINARY_RE.test(options.binaryPath)) {
      throw new Error(
        "computer-use binary must be an absolute path and must end in munim-computer-use.exe",
      );
    }
    return {
      command: options.binaryPath,
      args: [],
      env: {
        COMPUTER_USE_BROWSER: browser ? "1" : "0",
      },
    };
  }
  return {
    command: "npx",
    args: ["--yes", MUNIM_COMPUTER_USE_PACKAGE],
    env: {
      COMPUTER_USE_BROWSER: browser ? "1" : "0",
    },
    packageName: `npm:${MUNIM_COMPUTER_USE_PACKAGE}`,
  };
}

export type ComputerUseToolName =
  | "list_apps"
  | "get_app_state"
  | "click"
  | "type_text"
  | "screenshot";

/** Minimum tool surface required for the first vertical slice. */
export const COMPUTER_USE_REQUIRED_TOOLS: readonly ComputerUseToolName[] = [
  "list_apps",
  "get_app_state",
  "click",
  "type_text",
  "screenshot",
];

export function missingComputerUseTools(toolNames: readonly string[]): string[] {
  const available = new Set(toolNames);
  return COMPUTER_USE_REQUIRED_TOOLS.filter((name) => !available.has(name));
}

export function describeComputerUseTarget(binaryPath: string): string {
  return `Munim Computer Use ${MUNIM_COMPUTER_USE_VERSION} (${win32.basename(binaryPath)})`;
}
