// Живая проверка пути «модель → вызов тула → процесс bash → вывод → завершение» на настоящей сессии Pi
// с локальным мок-шлюзом. Печатает таймлайн событий с временами; наружу ничего не отправляет.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createPrsloyHarness } from "../../src/index.ts";
import { ScriptedOpenAiServer } from "../../test/scripted-openai-server.ts";

const command = process.argv[2] ?? "echo hi";
const mode = process.argv[3] ?? "plain"; // plain | abort
const timeoutSec = Number(process.argv[4] ?? 0);
const abortAfterMs = Number(process.argv[5] ?? 3000);
const hardStopMs = Number(process.argv[6] ?? 60_000);

const root = await mkdtemp(join(tmpdir(), "probe-"));
const agentDir = join(root, "agent");
const cwd = join(root, "project");
await mkdir(agentDir, { recursive: true });
await mkdir(cwd, { recursive: true });

const server = new ScriptedOpenAiServer((_req, index) =>
  index === 0
    ? {
        toolCalls: [
          { name: "bash", arguments: { command, ...(timeoutSec ? { timeout: timeoutSec } : {}) } },
        ],
        finishReason: "tool_calls",
      }
    : { text: "готово" },
);
await server.start();

const modelsPath = join(agentDir, "models.json");
await writeFile(
  modelsPath,
  JSON.stringify({
    providers: {
      mock: {
        baseUrl: server.baseUrl,
        apiKey: "test-key-not-secret",
        api: "openai-completions",
        models: [
          {
            id: "mock",
            name: "Mock",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 65536,
            maxTokens: 4096,
            compat: { supportsUsageInStreaming: true },
          },
        ],
      },
    },
  }),
);
const modelRuntime = await ModelRuntime.create({
  authPath: join(agentDir, "auth.json"),
  modelsPath,
});
const model = modelRuntime.getModel("mock", "mock");
const settingsManager = SettingsManager.inMemory({
  compaction: { enabled: false },
  retry: { enabled: false },
});
const resourceLoader = new DefaultResourceLoader({
  cwd,
  agentDir,
  settingsManager,
  extensionFactories: [
    createPrsloyHarness({ outputDir: join(root, "out"), settingsPath: join(root, "flags.json") }),
  ],
});
await resourceLoader.reload();
const { session } = await createAgentSession({
  cwd,
  agentDir,
  ...(model ? { model } : {}),
  thinkingLevel: "off",
  modelRuntime,
  resourceLoader,
  settingsManager,
  sessionManager: SessionManager.inMemory(cwd),
});

const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`;
let updates = 0;
const unsub = session.subscribe((event: any) => {
  if (event.type === "tool_execution_start")
    console.log(`${at()} start ${event.toolName} ${JSON.stringify(event.args).slice(0, 160)}`);
  else if (event.type === "tool_execution_update") updates += 1;
  else if (event.type === "tool_execution_end") {
    const content = event.result?.content ?? [];
    const text = content.map((c: any) => c.text ?? "").join("");
    console.log(
      `${at()} end isError=${event.isError} len=${text.length} head=${JSON.stringify(text.slice(0, 240))}`,
    );
  } else if (event.type === "agent_settled") console.log(`${at()} agent_settled`);
});

let timer: NodeJS.Timeout | undefined;
const hardStop = new Promise<string>((resolve) => {
  timer = setTimeout(() => resolve("HARD_STOP"), hardStopMs);
});
if (mode === "abort") {
  setTimeout(() => {
    console.log(`${at()} >>> abort()`);
    void session.abort();
  }, abortAfterMs);
}
const end = await Promise.race([session.prompt("запусти").then(() => "done"), hardStop]);
if (timer) clearTimeout(timer);
console.log(`${at()} END=${end} updates=${updates}`);
for (const m of (session.messages as any[]).filter((x) => x.role === "toolResult")) {
  const text = (m.content ?? []).map((c: any) => c.text ?? "").join("");
  console.log(`toolResult isError=${m.isError} ${JSON.stringify(text.slice(0, 400))}`);
}
unsub();
session.dispose();
await server.stop();
await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
process.exit(0);
