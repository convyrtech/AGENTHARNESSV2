import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vite-plus/test";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

interface BoundaryProbeResult {
  extensions: string[];
  settingsExtensions: string[];
}

async function probe(mode: "enabled" | "disabled"): Promise<BoundaryProbeResult> {
  const root = await mkdtemp(join(tmpdir(), `pi-builtin-mcp-boundary-${mode}-`));
  roots.push(root);
  const home = join(root, "home");
  const cwd = join(root, "project");
  const agentDir = join(home, ".pi", "agent");
  await Promise.all([mkdir(cwd, { recursive: true }), mkdir(agentDir, { recursive: true })]);
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ extensions: ["+builtin:mcp"] }),
  );

  // The SDK's resource loader and Pi's settings modules keep process-level state. Run the
  // integration check in a fresh process so other parallel test files cannot affect it.
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (/(_API_KEY|_TOKEN|_SECRET|_CREDENTIALS?)$/i.test(key)) delete environment[key];
  }
  Object.assign(environment, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    PI_CODING_AGENT_DIR: agentDir,
  });
  const fixture = join(import.meta.dirname, "builtin-mcp-boundary-probe.mjs");
  const args = [fixture, cwd, agentDir, mode];
  const { stdout, stderr } = await execFileAsync(process.execPath, args, {
    cwd,
    env: environment,
    timeout: 20_000,
  });
  expect(stderr).toBe("");
  return JSON.parse(stdout.trim()) as BoundaryProbeResult;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Pi built-in MCP boundary", () => {
  it("loads the enabled builtin as the positive control", async () => {
    const result = await probe("enabled");
    expect(result.extensions).toContain("builtin:mcp");
    expect(result.settingsExtensions).toContain("+builtin:mcp");
  });

  it("suppresses the same enabled builtin with the per-runtime override", async () => {
    const result = await probe("disabled");
    expect(result.extensions).not.toContain("builtin:mcp");
    expect(result.settingsExtensions).toContain("+builtin:mcp");
  });
});
