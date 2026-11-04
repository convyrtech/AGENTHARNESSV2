import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createMcpExtension } from "@earendil-works/pi-coding-agent";
import { createPixRuntime } from "../src/index.ts";

const [cwd, agentDir, mode] = process.argv.slice(2);
if (!cwd || !agentDir || (mode !== "enabled" && mode !== "disabled")) {
  throw new Error("builtin-mcp-boundary-probe requires cwd, agentDir, and mode");
}

const handle = await createPixRuntime({
  cwd,
  agentDir,
  tools: ["read"],
  extensionPaths: ["builtin:mcp"],
  extensionFactories: [
    {
      name: "mcp",
      builtin: true,
      factory: createMcpExtension({ loadConfig: () => ({ servers: [] }) }),
    },
  ],
  ...(mode === "disabled" ? { disabledBuiltinExtensions: ["mcp"] } : {}),
});

try {
  const extensions = handle.runtime.services.resourceLoader
    .getExtensions()
    .extensions.map((extension) => extension.path);
  const settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
  console.log(
    JSON.stringify({
      extensions,
      settingsExtensions: settings.extensions ?? [],
    }),
  );
} finally {
  await handle.dispose();
}
