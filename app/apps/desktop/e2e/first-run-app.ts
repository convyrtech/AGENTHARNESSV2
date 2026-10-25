/**
 * The real first run (no test bypass) for e2e: a fresh profile whose home folder has a Cyrillic name
 * with a space, a local mock of the PRSLOY gateway that accepts GOOD_KEY, and, with `withChats`,
 * synthetic Claude Code and Codex chats pointed at real project folders. Shared by
 * session-import.spec.ts and keyboard-key-screens.spec.ts.
 */
import { expect, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const electronBinary = require("electron") as string;
const appDirectory = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(appDirectory, "..", "..", "packages", "session-import", "test", "fixtures");
export const GOOD_KEY = "sk-good-0000abcd";
const WINDOWS_CWD = {
  claude: "C:\\Users\\Пётр\\Проекты\\сайт-пекарни",
  codex: "C:\\Users\\Пётр\\Проекты\\бот-заказов",
};

/** Accepts GOOD_KEY, answers every chat turn with one line, keeps the request bodies. */
function mockGateway(bodies: string[]): Server {
  return createServer((req, res) => {
    const authorized = req.headers.authorization === `Bearer ${GOOD_KEY}`;
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(authorized ? 200 : 401, { "content-type": "application/json" });
      res.end(JSON.stringify(authorized ? { data: [{ id: "deepseek-v4.1-flash-1017" }] } : {}));
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => (body += String(chunk)));
    req.on("end", () => {
      if (!authorized) {
        res.writeHead(401).end();
        return;
      }
      bodies.push(body);
      const chunk = (delta: object, finish: string | null = null) =>
        `data: ${JSON.stringify({
          id: "c1",
          object: "chat.completion.chunk",
          created: 0,
          model: "deepseek-v4.1-flash-1017",
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(chunk({ role: "assistant", content: "Продолжаю с того же места." }));
      res.write(chunk({}, "stop"));
      res.end("data: [DONE]\n\n");
    });
  });
}

async function rewriteCwd(dir: string, from: string, to: string): Promise<void> {
  const escapedFrom = JSON.stringify(from).slice(1, -1);
  const escapedTo = JSON.stringify(to).slice(1, -1);
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const path = join(entry.parentPath, entry.name);
    const text = await readFile(path, "utf8");
    if (text.includes(escapedFrom)) await writeFile(path, text.replaceAll(escapedFrom, escapedTo));
  }
}

export async function launchFirstRun(withChats: boolean) {
  const root = await mkdtemp(join(tmpdir(), "prsloy-import-e2e-"));
  const home = join(root, "Пётр Иванов");
  const userData = join(root, "userData");
  // Projects outside tmp: main never treats a /tmp folder as a project.
  const projects = await mkdtemp(join(homedir(), ".prsloy-import-e2e-"));
  const site = join(projects, "Проекты", "сайт-пекарни");
  await Promise.all([
    mkdir(join(userData, "prsloy"), { recursive: true }),
    mkdir(site, { recursive: true }),
    mkdir(join(projects, "Проекты", "бот-заказов"), { recursive: true }),
    mkdir(home, { recursive: true }),
  ]);
  if (withChats) {
    await cp(join(FIXTURES, "claude-code", "projects"), join(home, ".claude", "projects"), {
      recursive: true,
    });
    await cp(join(FIXTURES, "codex"), join(home, ".codex"), { recursive: true });
    await rewriteCwd(home, WINDOWS_CWD.claude, site);
    await rewriteCwd(home, WINDOWS_CWD.codex, join(projects, "Проекты", "бот-заказов"));
  }

  const bodies: string[] = [];
  const server = mockGateway(bodies);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await writeFile(
    join(userData, "prsloy", "state.json"),
    JSON.stringify({ baseUrl: `http://127.0.0.1:${port}/v1` }),
  );

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    ZENO_ISOLATED: "1",
    ZENO_NO_AUTO_RESUME: "1",
    LANG: "ru_RU.UTF-8",
  });
  for (const name of [
    "ELECTRON_RUN_AS_NODE",
    "ZENO_ENABLE_TEST_COMMANDS",
    "PI_CODING_AGENT_DIR",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
  ]) {
    delete env[name];
  }
  const app = await electron.launch({
    executablePath: electronBinary,
    args: [appDirectory, `--user-data-dir=${userData}`, "--lang=ru", "--password-store=basic"],
    cwd: appDirectory,
    env,
    timeout: 60_000,
  });
  const page = await app.firstWindow({ timeout: 60_000 });
  const close = async () => {
    await app.close().catch(() => undefined);
    server.close();
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    await rm(projects, { recursive: true, force: true }).catch(() => undefined);
  };
  return { app, page, site, userData, bodies, close };
}

export async function passKey(page: Page) {
  await expect(page.getByTestId("prsloy-first-run-key")).toBeVisible({ timeout: 60_000 });
  await page.getByPlaceholder("sk-…").fill(GOOD_KEY);
  await page.getByRole("button", { name: "Продолжить" }).click();
}
