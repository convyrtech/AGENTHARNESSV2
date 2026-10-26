import { createPixRuntime } from "../src/index.ts";

const cwd = process.argv[2];
const root = process.argv[3];
const agentDir = process.env.PI_CODING_AGENT_DIR;

if (!cwd || !agentDir) {
  throw new Error("zero-injection-probe requires cwd and PI_CODING_AGENT_DIR");
}

const handle = await createPixRuntime({ cwd, agentDir });
try {
  const snapshot = handle.snapshot();
  // Filter contextFiles to only those inside the test root, ignoring global AGENTS.md/CLAUDE.md
  if (root) {
    const allContextFiles = handle.runtime.services.resourceLoader.getAgentsFiles().agentsFiles;
    const fixtureContextFiles = allContextFiles.filter((f) => f.path.startsWith(root));
    snapshot.resources.contextFiles = fixtureContextFiles.length;
  }
  process.stdout.write(`${JSON.stringify(snapshot)}\n`);
} finally {
  await handle.dispose();
}
