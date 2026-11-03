import { isAbsolute } from "node:path";
import type { McpServerConfig } from "@earendil-works/pi-coding-agent";
import { MUNIM_COMPUTER_USE_TOOL_NAMES } from "@prsloy/harness";

export const CUA_COMPUTER_USE_TOOL_NAMES = [
  "list_apps",
  "list_windows",
  "get_window_state",
  "click",
  "type_text",
] as const;

export function selectComputerUseBackend(
  enabled: boolean,
  cuaBinary: string | undefined,
): "cua" | "munim" | undefined {
  if (!enabled) return undefined;
  return cuaBinary ? "cua" : "munim";
}

/** Only a matching, explicit local backend may be exposed in experimental mode. */
export function allowedMunimConfig(
  value: unknown,
  binaryPath: string | undefined,
): McpServerConfig | undefined {
  if (!value || typeof value !== "object" || !binaryPath || !isAbsolute(binaryPath))
    return undefined;
  const config = value as Record<string, unknown>;
  if (config.command !== binaryPath || config.enabled === false || config.disabled === true)
    return undefined;
  return {
    command: binaryPath,
    args: [],
    env: { COMPUTER_USE_BROWSER: "0" },
    exposure: "hidden",
    toolExposure: Object.fromEntries(
      MUNIM_COMPUTER_USE_TOOL_NAMES.map((name) => [name, "codemode"]),
    ),
  };
}

/** Cua is accepted only as an explicitly selected local executable. Ignore user config
 * overrides and construct the narrow MCP invocation without writing their config file. */
export function allowedCuaConfig(
  value: unknown,
  binaryPath: string | undefined,
): McpServerConfig | undefined {
  if (!value || typeof value !== "object" || !binaryPath || !isAbsolute(binaryPath))
    return undefined;
  const config = value as Record<string, unknown>;
  if (config.command !== binaryPath || config.enabled === false || config.disabled === true)
    return undefined;
  return {
    command: binaryPath,
    args: ["mcp", "--direct"],
    exposure: "hidden",
    // Codemode can discover these schemas, but guard hooks reject raw calls unless
    // they originate from an active PRSLOY wrapper; do not treat this as a sandbox.
    toolExposure: Object.fromEntries(CUA_COMPUTER_USE_TOOL_NAMES.map((name) => [name, "codemode"])),
  };
}
