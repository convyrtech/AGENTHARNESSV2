// Ключ отозвали посреди хода (дирижёр, 26.10): настоящий рантайм, харнесс и прокси надёжности на фейковом шлюзе.
// Шлюз ответил 401 — ход кончается ошибкой с текстом, который хост переводит в код "auth" (message.failed), а ui —
// в карточку «Ключ не подходит» с кнопкой «Изменить ключ» (настройки → Аккаунт). Пустого ответа нет, статуса хода
// под карточкой сбоя — тоже.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vite-plus/test";
import { createPixRuntime } from "../../agent-runtime/src/index.ts";
import { classifyModelError } from "../../agent-runtime/src/model-error.ts";
import {
  buildPrsloyModelsJsonProvider,
  PRSLOY_PROVIDER_ID,
} from "../../../apps/desktop/src/shared/prsloy-config.ts";
import { createPrsloyHarness } from "../src/index.ts";
import { closeSharedProxy } from "../src/reliability.ts";
import { ScriptedOpenAiServer } from "./scripted-openai-server.ts";

const root = mkdtempSync(join(tmpdir(), "prsloy-revoked-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

it("401 after a tool call: the turn ends with an «auth» error, not an empty answer, and no status card", async () => {
  let n = 0;
  const server = new ScriptedOpenAiServer(() =>
    n++ === 0
      ? {
          toolCalls: [{ name: "write", arguments: { path: "index.html", content: "<h1>Hi</h1>" } }],
        }
      : { status: 401, error: "Invalid API key" },
  );
  await server.start();
  const agentDir = mkdtempSync(join(root, "agent-"));
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: { [PRSLOY_PROVIDER_ID]: buildPrsloyModelsJsonProvider(server.baseUrl) },
    }),
  );
  const handle = await createPixRuntime({
    cwd: mkdtempSync(join(root, "ws-")),
    agentDir,
    model: { provider: PRSLOY_PROVIDER_ID, id: "deepseek-v4.1-flash-1017" },
    runtimeApiKeys: { [PRSLOY_PROVIDER_ID]: "revoked" },
    extensionFactories: [
      createPrsloyHarness({
        outputDir: join(root, "harness"),
        learningDir: join(root, "learning"),
        memoryDir: join(root, "memory"),
        settingsPath: join(agentDir, "prsloy-harness.json"),
      }),
    ],
    persistSession: false,
    projectTrusted: true,
    onExtensionUiRequest: () => {},
  });
  try {
    await handle.runtime.session.prompt("Сделай сайт-визитку");
    const messages = handle.runtime.session.messages as unknown as {
      role: string;
      stopReason?: string;
      errorMessage?: string;
      customType?: string;
    }[];
    const last = messages.filter((m) => m.role === "assistant").at(-1)!;
    expect(last.stopReason).toBe("error");
    expect(last.errorMessage).toMatch(/^401\b.*Invalid API key/);
    expect(classifyModelError(last.errorMessage, last.stopReason)).toBe("auth");
    // Без повторов по кругу: один вызов с инструментом, один отказ.
    expect(server.requests).toHaveLength(2);
    expect(messages.some((m) => m.customType === "prsloy-harness.turn-status")).toBe(false);
  } finally {
    await handle.dispose();
    await server.stop();
    await closeSharedProxy();
  }
}, 60_000);
