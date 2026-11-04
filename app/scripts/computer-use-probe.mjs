#!/usr/bin/env node
/**
 * Offline-safe MCP canary for the #104 prototype.
 *
 * It only starts a binary explicitly supplied by the caller.  It does not
 * download npx packages, enumerate windows, click, type, or capture a screen.
 * Use the separate Windows test protocol in docs/prsloy/COMPUTER-USE-104.md
 * after the operator has approved a controlled test application.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const binary = process.argv[2];
if (!binary || process.argv.includes("--help")) {
  console.error("Usage: node scripts/computer-use-probe.mjs <path-to-munim-computer-use.exe>");
  process.exit(binary ? 0 : 2);
}

const child = spawn(binary, [], {
  stdio: ["pipe", "pipe", "inherit"],
  windowsHide: true,
  env: { ...process.env, COMPUTER_USE_BROWSER: "0" },
});
const lines = createInterface({ input: child.stdout });
const pending = new Map();
let nextId = 0;
lines.on("line", (line) => {
  try {
    const message = JSON.parse(line);
    const resolve = pending.get(message.id);
    if (resolve) {
      pending.delete(message.id);
      resolve(message);
    }
  } catch {
    // Protocol diagnostics belong on stderr; keep the canary result readable.
  }
});

function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
      if (error) reject(error);
    });
  });
}

try {
  const initialized = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "prsloy-104-probe", version: "0.1.0" },
  });
  const listed = await request("tools/list", {});
  const tools = listed.result?.tools ?? [];
  console.log(
    JSON.stringify(
      {
        initialize: initialized.result?.serverInfo ?? initialized.error ?? null,
        tool_count: tools.length,
        tools: tools.map((tool) => tool.name).filter(Boolean),
        actions_executed: 0,
        cost_rub: 0,
      },
      null,
      2,
    ),
  );
} finally {
  child.stdin.end();
  child.kill();
}
