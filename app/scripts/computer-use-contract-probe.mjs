#!/usr/bin/env node
/**
 * Deterministic protocol probe for #104.  `--fake` is the CI/local path: it
 * emulates only the MCP messages and never touches a real window.  A real
 * binary path delegates to computer-use-probe.mjs.
 */
const fake = process.argv.includes("--fake");
if (!fake) {
  const binary = process.argv[2];
  if (!binary) {
    console.error("Usage: node scripts/computer-use-contract-probe.mjs --fake");
    console.error(
      "   or: node scripts/computer-use-contract-probe.mjs <path-to-munim-computer-use.exe>",
    );
    process.exit(2);
  }
  const result = await import("./computer-use-probe.mjs");
  void result;
}

function fakeServer() {
  let cancelled = false;
  return {
    request(method, params) {
      if (method === "initialize") return { serverInfo: { name: "fake-munim", version: "0.9.0" } };
      if (method === "tools/list") {
        return {
          tools: ["list_apps", "get_app_state", "click", "type_text", "screenshot"].map((name) => ({
            name,
          })),
        };
      }
      if (method === "notifications/cancelled") {
        cancelled = true;
        return null;
      }
      if (method !== "tools/call") throw new Error(`unexpected method ${method}`);
      if (cancelled) return { isError: true, text: "cancelled" };
      const name = params.name;
      if (name === "list_apps") return { isError: false, text: "Test Window pid 104" };
      if (name === "get_app_state")
        return { isError: false, text: "e1 Edit field; e2 Save button" };
      if (name === "type_text")
        return { isError: false, text: "typed PRSLOY-104", state: "e1 value=PRSLOY-104" };
      if (name === "click")
        return { isError: false, text: "clicked e2", state: "Saved PRSLOY-104" };
      if (name === "screenshot") return { isError: false, text: "image/png test-only" };
      return { isError: true, text: `unknown tool ${name}` };
    },
  };
}

if (fake) {
  const server = fakeServer();
  const initialized = server.request("initialize", {});
  const listed = server.request("tools/list", {});
  const calls = [
    ["list_apps", {}],
    ["get_app_state", { app: "104" }],
    ["type_text", { element: "e1", text: "PRSLOY-104", return_state: true }],
    ["click", { element: "e2", return_state: true }],
    ["screenshot", { app: "104" }],
  ].map(([name, arguments_]) => ({
    name,
    result: server.request("tools/call", { name, arguments: arguments_ }),
  }));
  const failed = server.request("tools/call", { name: "missing", arguments: {} });
  server.request("notifications/cancelled", {});
  const cancelled = server.request("tools/call", { name: "click", arguments: { element: "e2" } });
  const report = {
    initialize: initialized.serverInfo,
    tools: listed.tools.map((tool) => tool.name),
    calls,
    cancelled,
    simulated_error: failed,
    actions_executed: calls.length,
    cost_rub: 0,
    real_windows_touched: false,
  };
  console.log(JSON.stringify(report, null, 2));
}
