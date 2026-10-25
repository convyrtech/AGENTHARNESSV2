/**
 * prsloy-harness on the installed app (Windows: PortableGit bash, taskkill, Electron as node).
 *
 * A scripted fake model makes one tool call per prompt («harness step N»), and each test
 * checks the tool result text the app sent back to the model:
 *   1. `(node server.js P > srv.log 2>&1 &) && sleep 2 && curl …` → 200, server in the registry
 *   2. `pkill -f "server.js P"` → stopped via the registry, port free, the shell alive
 *   3. a command that hangs past the bash timeout (PRSLOY_BASH_TIMEOUT_SEC=5) → harness timeout note
 *   4. `taskkill /IM bash.exe /F` → blocked with the hint
 *   5. write of a broken .js → post-edit syntax line (node --check via Electron as node)
 *   7. `python -m http.server R &` → recorded as a finding (bundled Windows Python lacked `threading`)
 *   8. the fake gateway sends an a6 error inside the stream once → the reliability proxy retries,
 *      the user sees a normal answer (PRSLOY_RELIABILITY_PROVIDERS=zeno-fake)
 *   8a. the model leaks its tool call as text (DeepSeek: answer == reasoning + `</｜DSML｜ invoke>`) → the
 *      harness sends it back once, the next answer is a real write, the turn completes; no markup on screen
 *   9–12. second opinion (PRSLOY_REVIEW_MODEL=zeno-fake/zeno-fake): the fake reviewer answers FAIL with a
 *      real diff quote (card «нашла 1 замечание — исправляю» + one push back), FAIL with a made-up quote
 *      and PASS (card «замечаний нет»); step 12 edits only through bash (`sed -i`) — the turn diff comes
 *      from the harness shadow git (git next to Git Bash on Windows)
 *   6. `node server.js Q &` left running → port Q free after the app quits
 * Step 0 only records python in the agent's bash. Content checks are soft: every step runs and
 * reports. Artifacts: smoke-out/harness-requests.jsonl (every request the model got), session
 * JSONL files, harness-results.json, harness-bg-logs/ (registry process output).
 *
 * Self-contained on purpose (own launcher and fake model): helpers.ts launch() pins
 * ZENO_TOOLS=read,bash and a one-call FakeOpenAiServer. Local run without an installed app:
 * SMOKE_DEV_APP=<apps/desktop> (built) uses the dev Electron binary.
 */
import { expect, test, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import { once } from "node:events";
import { existsSync, readdirSync, statSync } from "node:fs";
import { appendFile, copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  beforeAllSmoke,
  exe,
  findings,
  outDir,
  send,
  shot,
  startHost,
  writeMetrics,
} from "./helpers.ts";

const PY = process.platform === "win32" ? "python" : "python3";
const BASH_TIMEOUT_SEC = 5;

interface ChatMessage {
  role?: string;
  content?: unknown;
}

function messageText(message: ChatMessage | undefined): string {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.map((p: { text?: string }) => p.text ?? "").join("");
}

type Step = { name: string; arguments: Record<string, unknown> };

/** OpenAI-compatible stream: «harness step N» → tool call N; after its result → short text. */
class ScriptedModel {
  readonly requests: { messages?: ChatMessage[] }[] = [];
  /** Запросы «harness flaky gateway»: первый получает ошибку a6 внутри потока. */
  flakyRequests = 0;
  /** Ответы «harness tool leak»: вызов инструмента текстом (как DeepSeek в A/B дирижёра). */
  leakRequests = 0;
  /** Промпты проверяющего (второе мнение харнесса). */
  readonly reviews: string[] = [];
  #server: Server;
  baseUrl = "";

  constructor(private readonly steps: Record<number, Step>) {
    this.#server = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += String(d)));
      req.on("end", () => this.#reply(req.url ?? "", body, res));
    });
  }

  async start(): Promise<void> {
    this.#server.listen(0, "127.0.0.1");
    await once(this.#server, "listening");
    const address = this.#server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    this.baseUrl = `http://127.0.0.1:${address.port}/v1`;
  }

  async stop(): Promise<void> {
    this.#server.closeAllConnections();
    this.#server.close();
  }

  /** Tool result text the app sent back for step N. */
  resultOf(step: number): string | undefined {
    for (const request of [...this.requests].reverse()) {
      const messages = request.messages ?? [];
      const lastUser = messages.findLastIndex((m) => m.role === "user");
      if (!messageText(messages[lastUser]).includes(`harness step ${step}`)) continue;
      const tool = messages.slice(lastUser + 1).find((m) => m.role === "tool");
      if (tool) return messageText(tool);
    }
    return undefined;
  }

  #reply(url: string, body: string, res: ServerResponse): void {
    if (!url.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    const parsed = JSON.parse(body || "{}") as { messages?: ChatMessage[] };
    this.requests.push(parsed);
    const messages = parsed.messages ?? [];
    const lastUser = messages.findLastIndex((m) => m.role === "user");
    const match = /harness step (\d+)/.exec(messageText(messages[lastUser]));
    const answered = messages.slice(lastUser + 1).some((m) => m.role === "tool");
    const step = match && !answered ? this.steps[Number(match[1])] : undefined;

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-harness-smoke",
          object: "chat.completion.chunk",
          created: 1,
          model: "zeno-fake",
          choices: [{ index: 0, delta, finish_reason: finish }],
          ...(finish
            ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
            : {}),
        })}\n\n`,
      );
    chunk({ role: "assistant", content: "" });
    // Проверяющий харнесса: его промпт несёт задачу пользователя — отвечаем ему раньше разбора шагов.
    const prompt = messageText(messages[lastUser]);
    if (prompt.startsWith("Ты проверяющий")) {
      this.reviews.push(prompt);
      const evidence = prompt.includes("(review real)")
        ? "return a - b;"
        : prompt.includes("(review fake)")
          ? "return a * b * 2;"
          : undefined;
      const verdict = evidence
        ? { verdict: "FAIL", items: [{ file: "calc.js", line: 2, problem: "ошибка", evidence }] }
        : { verdict: "PASS", items: [] };
      chunk({ content: JSON.stringify(verdict) });
      chunk({}, "stop");
      res.end("data: [DONE]\n\n");
      return;
    }
    const lastText = messageText(messages[lastUser]);
    if (!answered && lastText.includes("harness tool leak")) {
      this.leakRequests += 1;
      const thought = `${"The page needs a resize handler so the motion stays in sync. ".repeat(20)}Let me check motion.js for a resize handler.`;
      chunk({ reasoning_content: thought });
      chunk({ content: `${thought}</｜DSML｜ parameter>\n</｜DSML｜ invoke>\n</｜DSML｜ calls>` });
      chunk({}, "stop");
      res.end("data: [DONE]\n\n");
      return;
    }
    if (!answered && lastText.includes("Твой последний вызов инструмента не дошёл")) {
      chunk({
        tool_calls: [
          {
            index: 0,
            id: `call_harness_leak_${this.requests.length}`,
            type: "function",
            function: {
              name: "write",
              arguments: JSON.stringify({ path: "leak.txt", content: "real call\n" }),
            },
          },
        ],
      });
      chunk({}, "tool_calls");
      res.end("data: [DONE]\n\n");
      return;
    }
    if (!answered && messageText(messages[lastUser]).includes("harness flaky gateway")) {
      this.flakyRequests += 1;
      if (this.flakyRequests === 1) {
        // Как a6 в E8q: ошибка внутри уже начатого потока (200, первое событие — ошибка).
        res.end(
          `data: ${JSON.stringify({ error: { message: "等待响应超时，请稍后重试 上游服务" } })}\n\n`,
        );
        return;
      }
      chunk({ content: "Ответ после сбоя шлюза." });
      chunk({}, "stop");
      res.end("data: [DONE]\n\n");
      return;
    }
    if (step) {
      chunk({
        tool_calls: [
          {
            index: 0,
            id: `call_harness_${match?.[1]}_${this.requests.length}`,
            type: "function",
            function: { name: step.name, arguments: JSON.stringify(step.arguments) },
          },
        ],
      });
      chunk({}, "tool_calls");
    } else {
      chunk({ content: "Готово." });
      chunk({}, "stop");
    }
    res.end("data: [DONE]\n\n");
  }
}

async function freePort(): Promise<number> {
  const server = createNetServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  server.close();
  await once(server, "close");
  return port;
}

async function portAnswers(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) });
    return res.status > 0;
  } catch {
    return false;
  }
}

function findFiles(dir: string, ext: string, depth = 6): string[] {
  if (depth < 0 || !existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    try {
      if (statSync(path).isDirectory()) out.push(...findFiles(path, ext, depth - 1));
      else if (name.endsWith(ext)) out.push(path);
    } catch {
      // unreadable entry
    }
  }
  return out;
}

const state: {
  app?: ElectronApplication | undefined;
  page?: Page;
  model?: ScriptedModel;
  root?: string;
  userData?: string;
  workspace?: string;
  serverPort: number;
  leftPort: number;
  pyPort: number;
  results: Record<string, string | undefined>;
} = { serverPort: 0, leftPort: 0, pyPort: 0, results: {} };

async function launchApp(steps: Record<number, Step>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "prsloy-smoke-harness-"));
  const agentDir = join(root, "smoke-pi-agent");
  const userData = join(root, "userData");
  const workspace = join(root, "workspace");
  await Promise.all([agentDir, userData, workspace].map((d) => mkdir(d, { recursive: true })));
  // Сервер для шагов реестра: только node (python из runtimes на Windows может быть неполным, шаг 7).
  await writeFile(
    join(workspace, "server.js"),
    `const http = require("node:http");
const port = Number(process.argv[2]);
http.createServer((q, r) => r.end("ok")).listen(port, "127.0.0.1", () =>
  console.log("listening on http://127.0.0.1:" + port),
);
`,
  );
  const model = new ScriptedModel(steps);
  await model.start();
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "zeno-fake": {
          baseUrl: model.baseUrl,
          apiKey: "test-key-not-secret",
          api: "openai-completions",
          models: [
            {
              id: "zeno-fake",
              name: "Fake Model",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 16384,
              maxTokens: 1024,
              compat: { supportsUsageInStreaming: true },
            },
          ],
        },
      },
    }),
  );

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    // Never hand runner credentials to the app under test.
    if (value === undefined || /TOKEN|SECRET|PASSWORD|^AWS_|^CSC_|^ACTIONS_/i.test(key)) continue;
    env[key] = value;
  }
  delete env.ELECTRON_RUN_AS_NODE;
  if (process.platform !== "win32") env.HOME = join(root, "home");
  Object.assign(env, {
    PI_CODING_AGENT_DIR: agentDir,
    ZENO_WORKSPACE: workspace,
    ZENO_MODEL_PROVIDER: "zeno-fake",
    ZENO_MODEL_ID: "zeno-fake",
    ZENO_TOOLS: "read,bash,write,edit,bash_background,process",
    ZENO_ENABLE_TEST_COMMANDS: "1",
    ZENO_NO_AUTO_RESUME: "1",
    PRSLOY_BASH_TIMEOUT_SEC: String(BASH_TIMEOUT_SEC),
    // Прокси надёжности на фейковом провайдере (в продукте — провайдер prsloy).
    PRSLOY_RELIABILITY_PROVIDERS: "zeno-fake",
    // Второе мнение: в продукте пара по семье модели, здесь — та же фейковая модель.
    PRSLOY_REVIEW_MODEL: "zeno-fake/zeno-fake",
  });

  const devApp = process.env.SMOKE_DEV_APP;
  const executablePath = devApp
    ? (createRequire(import.meta.url)("electron") as unknown as string)
    : exe;
  const mainLog = join(outDir, "harness-main.log");
  const app = await electron.launch({
    executablePath,
    args: [...(devApp ? [devApp] : []), `--user-data-dir=${userData}`],
    cwd: workspace,
    env,
    timeout: 120_000,
  });
  app.process().stdout?.on("data", (d) => void appendFile(mainLog, d));
  app.process().stderr?.on("data", (d) => void appendFile(mainLog, d));
  const page = await app.firstWindow({ timeout: 120_000 });
  page.on(
    "console",
    (m) => void appendFile(join(outDir, "harness-renderer.log"), `[${m.type()}] ${m.text()}\n`),
  );
  await page.waitForSelector('[data-testid="zeno-app"][data-bootstrap-ready="true"]', {
    timeout: 180_000,
  });
  Object.assign(state, { app, page, model, root, userData, workspace });
}

const CALC =
  "function sum(a, b) {\n  return a + b;\n}\nfunction mul(a, b) {\n  return a * b;\n}\nmodule.exports = { sum, mul };\n";

async function step(n: number, suffix = ""): Promise<string> {
  const { page, model } = state;
  if (!page || !model) throw new Error("app not launched");
  await send(page, `harness step ${n}${suffix}`);
  await expect.poll(() => model.resultOf(n), { timeout: 60_000 }).not.toBeUndefined();
  const result = model.resultOf(n) ?? "";
  state.results[`step${n}`] = result;
  await writeFile(join(outDir, "harness-results.json"), JSON.stringify(state.results, null, 2));
  return result;
}

test.beforeAll(async () => {
  if (!process.env.SMOKE_DEV_APP) await beforeAllSmoke();
  else await mkdir(outDir, { recursive: true });
  state.serverPort = await freePort();
  state.leftPort = await freePort();
  state.pyPort = await freePort();
  await launchApp({
    0: {
      name: "bash",
      arguments: {
        command: `command -v ${PY} python python3 py; ${PY} --version; ${PY} -c "import http.server, sys; print(sys.executable)"; echo PATH=$PATH`,
      },
    },
    1: {
      name: "bash",
      arguments: {
        command: `(node server.js ${state.serverPort} > srv.log 2>&1 &) && sleep 2 && curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:${state.serverPort}/`,
      },
    },
    2: {
      name: "bash",
      arguments: { command: `pkill -f "server.js ${state.serverPort}"; echo shell-alive` },
    },
    3: { name: "bash", arguments: { command: "echo before-hang; sleep 60; echo never" } },
    4: { name: "bash", arguments: { command: "taskkill /IM bash.exe /F" } },
    5: { name: "write", arguments: { path: "broken.js", content: "const a = ;\n" } },
    6: { name: "bash", arguments: { command: `node server.js ${state.leftPort} &` } },
    7: { name: "bash", arguments: { command: `${PY} -m http.server ${state.pyPort} &` } },
    9: { name: "write", arguments: { path: "calc.js", content: CALC.replace("a + b", "a - b") } },
    10: { name: "write", arguments: { path: "calc2.js", content: CALC } },
    11: { name: "write", arguments: { path: "calc3.js", content: CALC } },
    12: {
      name: "bash",
      arguments: {
        command:
          "printf 'const a = 1;\\nconst b = 2;\\nconst c = 3;\\nconst d = 4;\\nconst e = 5;\\nconst f = 6;\\n' > nums.js && sed -i 's/= 6/= 66/' nums.js && echo edited",
      },
    },
  });
  await startHost(state.page!);
});

test.afterAll(async () => {
  const { app, model, root, userData } = state;
  const proc = app?.process();
  await Promise.race([
    app?.close().catch(() => undefined),
    new Promise((r) => setTimeout(r, 30_000)),
  ]);
  if (proc && proc.exitCode === null) proc.kill();
  if (model) {
    await writeFile(
      join(outDir, "harness-requests.jsonl"),
      model.requests.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
    await model.stop();
  }
  // Session transcripts (pi JSONL) wherever the app keeps them for this run.
  const sessions = [root, userData].flatMap((dir) => (dir ? findFiles(dir, ".jsonl") : []));
  await mkdir(join(outDir, "harness-sessions"), { recursive: true });
  for (const file of new Set(sessions)) {
    await copyFile(file, join(outDir, "harness-sessions", basename(file))).catch(() => undefined);
  }
  // Логи фоновых процессов реестра (вывод сервера, если он упал).
  const bgLogs = findFiles(join(tmpdir(), "prsloy-harness"), ".log", 3);
  await mkdir(join(outDir, "harness-bg-logs"), { recursive: true });
  for (const file of bgLogs) {
    const name = `${basename(join(file, ".."))}-${basename(file)}`;
    await copyFile(file, join(outDir, "harness-bg-logs", name)).catch(() => undefined);
  }
  await writeMetrics({
    harness: { sessions: sessions.length, results: Object.keys(state.results) },
  });
});

test("harness on the installed app: steps 0–12", async () => {
  await test.step("0: python in the agent's bash (diagnostics only)", async () => {
    const result = await step(0);
    test.info().annotations.push({ type: "python", description: result.slice(0, 2000) });
  });

  await test.step("1: `(node server.js &)` goes to the harness registry", async () => {
    const result = await step(1);
    expect.soft(result).toMatch(/^\s*\[exit 0 · /);
    expect.soft(result).toContain("200");
    expect.soft(result).toContain("запущен через реестр харнесса");
    expect.soft(result).toMatch(new RegExp(`порт ${state.serverPort}`));
  });

  await test.step("2: pkill -f is routed through the registry, the shell survives", async () => {
    const result = await step(2);
    expect.soft(result).toMatch(/^\s*\[exit 0 · /);
    expect.soft(result).toContain("shell-alive");
    expect.soft(result).toContain("выполнено через реестр: остановлены bg1");
    await expect.poll(() => portAnswers(state.serverPort), { timeout: 15_000 }).toBe(false);
  });

  await test.step("3: a hanging command hits the harness bash timeout", async () => {
    const started = Date.now();
    const result = await step(3);
    expect.soft(result).toContain("before-hang");
    expect.soft(result).not.toContain("never");
    expect.soft(result).toContain(`[Процесс остановлен по таймауту ${BASH_TIMEOUT_SEC} с.]`);
    expect.soft(Date.now() - started).toBeLessThan(55_000);
  });

  await test.step("4: taskkill of bash.exe is blocked with the hint", async () => {
    const result = await step(4);
    expect.soft(result).toContain("«taskkill /IM bash.exe /F» не выполнено");
    expect.soft(result).toContain("process action=stop");
  });

  await test.step("5: a broken .js write gets the post-edit syntax line", async () => {
    const result = await step(5);
    expect.soft(result).toContain("[Проверка синтаксиса (node --check): ОШИБКА в broken.js");
    expect.soft(result).toContain("SyntaxError");
    await shot(state.page!, "harness-steps");
  });

  await test.step("7: `python -m http.server &` (finding for the runtime owner)", async () => {
    const result = await step(7);
    const up = await portAnswers(state.pyPort);
    const f = findings("harness-python-http", process.env.SMOKE_STRICT_PYTHON_HTTP === "1");
    f.check("python -m http.server serves the preview", up, result.slice(0, 1500));
    await f.finish();
  });

  await test.step("8: an in-stream gateway error is retried by the proxy, the user sees an answer", async () => {
    const { page, model } = state;
    await send(page!, "harness flaky gateway");
    await expect(page!.getByText("Ответ после сбоя шлюза.").first()).toBeVisible({
      timeout: 30_000,
    });
    expect.soft(model!.flakyRequests).toBe(2);
    expect.soft(await page!.getByText("等待响应超时").count()).toBe(0);
    await shot(page!, "harness-flaky-gateway");
  });

  await test.step("8a: a tool call leaked as text is retried, the turn completes", async () => {
    const { page, model, workspace } = state;
    await send(page!, "harness tool leak");
    await expect
      .poll(() => existsSync(join(workspace!, "leak.txt")), { timeout: 30_000 })
      .toBe(true);
    expect.soft(model!.leakRequests).toBe(1);
    // Ход дошёл до конца: после результата write модель спросили ещё раз (ответ «Готово.»).
    await expect
      .poll(
        () =>
          model!.requests.some((r) => {
            const m = r.messages ?? [];
            const note = m.findLastIndex((x) => messageText(x).includes("Твой последний вызов"));
            return note >= 0 && m.slice(note + 1).some((x) => x.role === "tool");
          }),
        { timeout: 30_000 },
      )
      .toBe(true);
    expect.soft(await page!.locator("p", { hasText: "DSML" }).count()).toBe(0);
    expect
      .soft(
        await page!
          .locator("p", { hasText: "Let me check motion.js for a resize handler." })
          .count(),
      )
      .toBe(0);
    await shot(page!, "harness-tool-leak");
  });

  await test.step("9–12: second opinion of another model on the turn diff", async () => {
    const { page, model } = state;
    // Карточки ревью считаем по стабильным атрибутам HarnessCard (вид карточки может меняться),
    // а их видимый текст проверяем отдельно: он должен говорить то же самое.
    const review = (verdict: "pass" | "fail") =>
      page!.locator(
        `[data-testid="harness-card"][data-harness="review"][data-verdict="${verdict}"]`,
      );
    const cards = (verdict: "pass" | "fail") => review(verdict).count();
    const pass = "pass" as const;
    const fail = "fail" as const;

    await step(9, " (review real)");
    await expect.poll(() => cards(fail), { timeout: 30_000 }).toBe(1);
    await expect(review(fail)).toHaveAttribute("data-count", "1");
    await expect(review(fail)).toContainText("Вторая модель нашла 1 замечание — исправляю");
    // Один возврат: писатель получил замечание с цитатой, второго ревью в ходе нет.
    await expect
      .poll(
        () =>
          model!.requests.some((r) =>
            JSON.stringify(r.messages ?? []).includes("Вторая модель другого семейства"),
          ),
        { timeout: 30_000 },
      )
      .toBe(true);
    expect.soft(model!.reviews.filter((p) => p.includes("(review real)"))).toHaveLength(1);
    expect.soft(model!.reviews.at(-1)).toContain("+  return a - b;");
    await shot(page!, "harness-review-fail");

    await step(10, " (review fake)");
    await expect.poll(() => cards(pass), { timeout: 30_000 }).toBe(1);
    await expect(review(pass)).toContainText("Проверила вторая модель: замечаний нет");
    await step(11, " (review pass)");
    await expect.poll(() => cards(pass), { timeout: 30_000 }).toBe(2);
    expect.soft(await cards(fail)).toBe(1);

    const bashOnly = await step(12, " (review pass)");
    expect.soft(bashOnly).toContain("edited");
    await expect.poll(() => cards(pass), { timeout: 30_000 }).toBe(3);
    expect.soft(model!.reviews.at(-1)).toContain("+const f = 66;");
    state.results.reviews = String(model!.reviews.length);
    await shot(page!, "harness-review-pass");
  });

  await test.step("6: a background server left running dies with the app", async () => {
    const result = await step(6);
    expect.soft(result).toContain("запущен через реестр харнесса");
    await expect.poll(() => portAnswers(state.leftPort), { timeout: 15_000 }).toBe(true);
    const proc = state.app!.process();
    await Promise.race([
      state.app!.close().catch(() => undefined),
      new Promise((r) => setTimeout(r, 30_000)),
    ]);
    if (proc.exitCode === null) proc.kill();
    state.app = undefined; // afterAll не трогает закрытое приложение
    await expect.poll(() => portAnswers(state.leftPort), { timeout: 20_000 }).toBe(false);
  });
});
