import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync } from "node:fs";

const model = process.argv[2];
const targetPid = Number(process.argv[3]);
const output = process.argv[4];
const keyPath =
  process.env.PRSLOY_KEY_FILE ??
  "C:\\Users\\paxalb\\AppData\\Local\\Temp\\opencode\\prsloy-key.txt";
if (!model || !targetPid || !output)
  throw new Error("usage: node computer-use-agent-loop.mjs <model> <pid> <output.json>");
const apiKey = readFileSync(keyPath, "utf8").trim();
const binary =
  "C:\\Users\\paxalb\\AppData\\Local\\Temp\\opencode\\munim-104\\munim-computer-use.exe";
const safeEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) =>
    /^(?:PATH|PATHEXT|SystemRoot|WINDIR|TEMP|TMP|HOME|USERPROFILE|COMSPEC|LANG|LC_)/u.test(name),
  ),
);
const child = spawn(binary, [], {
  stdio: ["pipe", "pipe", "inherit"],
  windowsHide: true,
  env: { ...safeEnv, COMPUTER_USE_BROWSER: "0" },
});
const pending = new Map();
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  try {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  } catch {}
});
let nextId = 0;
function rpc(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      (error) => error && reject(error),
    );
  });
}
function text(result) {
  return (result?.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}
function toolResult(name, result) {
  return {
    tool_call_id: name,
    role: "tool",
    name,
    content: text(result) || JSON.stringify(result),
  };
}
async function complete(messages, tools) {
  const response = await fetch("https://api.prsloy.online/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      tools,
      tool_choice: "auto",
      max_tokens: 1024,
      temperature: 0,
      stream: false,
    }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`gateway_http_${response.status}`);
  return body;
}
const started = Date.now();
const calls = [];
let error;
let final = "";
let totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
try {
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "prsloy-104-agent-loop", version: "0.1.0" },
  });
  const listed = await rpc("tools/list");
  const allowed = new Set(["list_apps", "get_app_state", "type_text", "click", "screenshot"]);
  const tools = (listed.result?.tools ?? [])
    .filter((tool) => allowed.has(tool.name))
    .map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
    }));
  const messages = [
    {
      role: "system",
      content: `You control only the Windows test fixture with PID ${targetPid}. Use tools, never invent success. Task: in the fixture, enter PRSLOY-104-MARKER in the text field, click Save test marker, then verify the saved status. Start with list_apps and get_app_state. After every action rely on the returned fresh state.`,
    },
    { role: "user", content: "Выполни задачу в тестовом окне и проверь результат." },
  ];
  for (let turn = 0; turn < 8; turn += 1) {
    const reply = await complete(messages, tools);
    const usage = reply.usage ?? {};
    totalUsage.prompt_tokens += usage.prompt_tokens ?? 0;
    totalUsage.completion_tokens += usage.completion_tokens ?? 0;
    totalUsage.total_tokens += usage.total_tokens ?? 0;
    const assistant = reply.choices?.[0]?.message ?? {};
    messages.push(assistant);
    const toolCalls = assistant.tool_calls ?? [];
    if (!toolCalls.length) {
      final = assistant.content ?? "";
      break;
    }
    for (const call of toolCalls) {
      const name = call.function?.name;
      const args = JSON.parse(call.function?.arguments ?? "{}");
      const safeArgs = { ...args };
      if (["list_apps", "get_app_state", "screenshot"].includes(name))
        safeArgs.app ??= String(targetPid);
      if (["type_text", "click"].includes(name)) safeArgs.app ??= String(targetPid);
      const result = await rpc("tools/call", { name, arguments: safeArgs });
      calls.push({
        name,
        arguments: safeArgs,
        error: Boolean(result.result?.isError),
        text: text(result.result).slice(0, 500),
      });
      messages.push({ ...toolResult(name, result.result), tool_call_id: call.id });
    }
  }
} catch (cause) {
  error = cause instanceof Error ? cause.message : String(cause);
} finally {
  child.stdin.end();
  child.kill();
}
const report = {
  model,
  target_pid: targetPid,
  final,
  calls,
  usage: totalUsage,
  latency_ms: Date.now() - started,
  error: error ?? null,
  cost_rub: null,
};
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(
  JSON.stringify(
    {
      model,
      final,
      calls: calls.map(({ name, error, text }) => ({ name, error, text })),
      usage: totalUsage,
      latency_ms: report.latency_ms,
      error: report.error,
    },
    null,
    2,
  ),
);
