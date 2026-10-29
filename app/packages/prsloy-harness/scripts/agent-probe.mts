// Замер пользы разведчика на настоящем проекте (не часть приложения): один и тот же вопрос
// задаётся агенту дважды — с разведчиком и без. Агент только читает: ни write, ни edit, ни bash,
// поэтому чужой проект он не изменит. Ключ берётся из PRSLOY_GATEWAY_KEY, на диск не пишется.
//
//   node --experimental-strip-types scripts/agent-probe.mts <cwd> <вопросы через ||> <off|same> [модель]
// Несколько вопросов идут одной сессией — так видно, как растёт контекст в длинной сессии.
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPixRuntime } from "../../agent-runtime/src/index.ts";
import { createWriteBoundary } from "../../../apps/desktop/src/agent-host/write-boundary.ts";
import {
  buildPrsloyModelsJsonProvider,
  PRSLOY_PROVIDER_ID,
} from "../../../apps/desktop/src/shared/prsloy-config.ts";
import { createPrsloyHarness } from "../src/index.ts";

const [, , cwd, questionsArg, exploreArg, modelArg] = process.argv;
const questions = (questionsArg ?? "")
  .split("||")
  .map((q) => q.trim())
  .filter(Boolean);
const explore = (exploreArg ?? "off") as "off" | "same" | "cheap";
const modelName = modelArg ?? "deepseek-v4.1-flash-1017";
const key = process.env.PRSLOY_GATEWAY_KEY;
if (!cwd || questions.length === 0)
  throw new Error("usage: agent-probe.mts <cwd> <вопросы через ||> <off|same|cheap> [модель]");
if (!key) throw new Error("нет PRSLOY_GATEWAY_KEY в окружении");

const agentDir = join(tmpdir(), `agent-probe-${process.pid}-${explore}`);
mkdirSync(agentDir, { recursive: true });
writeFileSync(
  join(agentDir, "models.json"),
  JSON.stringify({
    providers: {
      [PRSLOY_PROVIDER_ID]: buildPrsloyModelsJsonProvider("https://api.prsloy.online/v1"),
    },
  }),
);
const settingsPath = join(agentDir, "prsloy-harness.json");
writeFileSync(settingsPath, JSON.stringify({ explore }));

const handle = await createPixRuntime({
  cwd,
  agentDir,
  model: { provider: PRSLOY_PROVIDER_ID, id: modelName },
  runtimeApiKeys: { [PRSLOY_PROVIDER_ID]: key },
  extensionFactories: [
    createWriteBoundary({ agentDir }),
    createPrsloyHarness({
      outputDir: join(agentDir, "harness"),
      profile: "code",
      settingsPath,
      memoryDir: join(agentDir, "memory"),
      // Мерим ровно вклад разведчика: остальные надстройки (второе мнение, устаревшие описания,
      // гейты, память) выключены, иначе их собственные вызовы моделей путают цифры.
      disable: {
        staleDocs: true,
        secondOpinion: true,
        stopGate: true,
        memory: true,
        autoMemory: true,
        digest: true,
        lessons: true,
        reusePrompt: true,
        findReady: true,
        research: true,
        toolLeak: true,
        turnChanges: true,
        honestExit: true,
      },
    }),
  ],
  // Только чтение: проект пользователя замер менять не должен. Разведчика надо явно разрешить,
  // иначе рантайм отфильтрует его инструментом-списком и «включённый» режим ничего не померит.
  tools: ["read", "grep", "find", "ls", ...(explore === "off" ? [] : ["explore"])],
  persistSession: true,
  sessionDir: join(agentDir, "sessions"),
  projectTrusted: true,
  onExtensionUiRequest: (request: unknown) => {
    const r = request as { method?: string; runtimeId?: string; requestId?: string };
    if (r.method === "confirm" || r.method === "select")
      handle.respondExtensionUi({
        runtimeId: r.runtimeId ?? "",
        requestId: r.requestId ?? "",
        ok: true,
        value: false,
      });
  },
});

const session = handle.runtime.session;
const peak = (): number => {
  const msgs = session.state?.messages ?? [];
  let max = 0;
  for (const m of msgs as { role?: string; usage?: { input?: number } }[]) {
    if (m.role === "assistant") max = Math.max(max, m.usage?.input ?? 0);
  }
  return max;
};
const countCalls = (): Record<string, number> =>
  (session.state?.messages ?? [])
    .flatMap((m: { role?: string; content?: unknown }) =>
      m.role === "assistant" && Array.isArray(m.content)
        ? m.content
            .filter((p: { type?: string }) => p.type === "toolCall")
            .map((p: { name?: string }) => p.name ?? "?")
        : [],
    )
    .reduce<Record<string, number>>((acc, name) => ({ ...acc, [name]: (acc[name] ?? 0) + 1 }), {});

const startedAll = Date.now();
for (const [index, question] of questions.entries()) {
  const before = session.getSessionStats();
  const started = Date.now();
  let error: string | undefined;
  try {
    await session.prompt(
      `Ответь на вопрос по этому проекту: ${question}\nОтвечай коротко, с путями файлов и номерами строк. Ничего не меняй.`,
    );
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const seconds = (Date.now() - started) / 1000;
  const after = session.getSessionStats();
  const calls = countCalls();
  console.log(
    `[${index + 1}] ${seconds.toFixed(1)} с; токены вх/вых: ${after.tokens.input - before.tokens.input}/${
      after.tokens.output - before.tokens.output
    }; пик контекста родителя: ${peak()}; вызовы: ${JSON.stringify(calls)}${
      error ? `; ошибка: ${error}` : ""
    }`,
  );
}
const total = session.getSessionStats();
console.log(`---`);
console.log(
  `всего: ${((Date.now() - startedAll) / 1000).toFixed(1)} с; токены вх/вых: ${total.tokens.input}/${total.tokens.output}; пик контекста родителя: ${peak()}`,
);
await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
session.dispose();
process.exit(0);
