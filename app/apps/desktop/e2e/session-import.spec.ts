/**
 * #22 I1: chats from other agents on the first run, in the product path (no test commands).
 * A fresh profile whose home folder has a Cyrillic name with a space and holds synthetic Claude
 * Code and Codex chats (packages/session-import/test/fixtures, project folders pointed at real
 * folders here). Key → «Перенести чаты из других программ?» → «Перенести» → the folder step
 * offers the imported project → the app lists the imported chat, and continuing it sends the
 * code-written summary to the model. A second profile with no other agents never sees the step.
 *
 * IMPORT_SHOTS=1 saves docs/prsloy/screens/first-run-import-<mode>.png.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { shot } from "./features-helpers.ts";
import { expect, test, type Page } from "@playwright/test";
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
const SCREENS = join(appDirectory, "..", "..", "docs", "prsloy", "screens");
const GOOD_KEY = "sk-good-0000abcd";
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

async function launch(withChats: boolean) {
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

async function passKey(page: Page) {
  await expect(page.getByTestId("prsloy-first-run-key")).toBeVisible({ timeout: 60_000 });
  await page.getByPlaceholder("sk-…").fill(GOOD_KEY);
  await page.getByRole("button", { name: "Продолжить" }).click();
}

test("first run brings Claude Code and Codex chats over and continues one", async () => {
  test.setTimeout(240_000);
  const launched = await launch(true);
  const { page } = launched;
  try {
    await passKey(page);
    const step = page.getByTestId("prsloy-first-run-import");
    await expect(step).toBeVisible({ timeout: 60_000 });
    await expect(step.getByRole("heading")).toHaveText("Перенести чаты из других программ?");
    const claude = page.getByTestId("prsloy-import-tool-claude-code");
    await expect(claude).toContainText("Claude Code");
    await expect(claude).toContainText("3 чата в 1 проекте");
    await expect(page.getByTestId("prsloy-import-tool-codex")).toContainText("1 чат в 1 проекте");
    const axe = await new AxeBuilder({ page })
      .setLegacyMode(true)
      .withTags(["wcag2a", "wcag2aa"])
      .include('[data-testid="prsloy-first-run-import"]')
      .analyze();
    expect(axe.violations.map((v: { id: string }) => v.id)).toEqual([]);
    if (process.env.IMPORT_SHOTS) {
      await page.screenshot({ path: join(SCREENS, "first-run-import.png") });
    }
    // the fixtures are from October 2026; make sure both tools are ticked whatever today is
    for (const tool of ["claude-code", "codex"]) {
      const box = page.getByTestId(`prsloy-import-tool-${tool}`).locator("input");
      if (!(await box.isChecked())) await box.check();
    }
    await page.getByTestId("prsloy-import-submit").click();
    await expect(page.getByTestId("prsloy-import-result")).toHaveText("Перенёс 4 чата", {
      timeout: 60_000,
    });
    await page.getByTestId("prsloy-import-next").click();
    // the search step (#23) comes next; «Не сейчас»
    await page.getByTestId("first-run-search-skip").click();

    // the imported project is offered first on the folder step
    await expect(page.getByTestId("prsloy-first-run-folder")).toBeVisible({ timeout: 60_000 });
    const recent = page.getByTestId("prsloy-folder-recent");
    await expect(recent.getByRole("button").first()).toHaveAttribute("title", /сайт-пекарни$/u);
    await recent.getByRole("button").first().click();
    await page.waitForSelector('[data-testid="zeno-app"][data-bootstrap-ready="true"]', {
      timeout: 120_000,
    });

    // the imported chat is an ordinary chat of the project, and continuing it works
    const card = page.getByTestId("project-card").filter({ hasText: "сайт-пекарни" }).first();
    if ((await card.getAttribute("data-expanded")) !== "true") {
      await card.getByTestId("workspace-current").click();
    }
    const chat = page.getByText("Пекарня «Колосок»").first();
    await expect(chat).toBeVisible({ timeout: 60_000 });
    await chat.click();
    await expect(page.getByTestId("timeline")).toContainText("Добавил prices.html.", {
      timeout: 30_000,
    });
    await page.getByTestId("prompt-input").fill("Добавь страницу контактов");
    await page.getByTestId("send-prompt").click();
    await expect(page.getByTestId("timeline")).toContainText("Продолжаю с того же места.", {
      timeout: 90_000,
    });
    const sent = launched.bodies.at(-1) ?? "";
    expect(sent).toContain("Перенесённый чат из Claude Code");
    expect(sent).toContain("Добавь страницу контактов");
    expect(sent).not.toContain("Нужно начать с главной.");

    // the journal and the files are in PRSLOY's folders
    const ledger = JSON.parse(
      await readFile(join(launched.userData, "prsloy", "import-ledger.json"), "utf8"),
    ) as { entries: unknown[] };
    expect(ledger.entries).toHaveLength(4);
  } finally {
    await launched.close();
  }
});

test("no other agents: the first run skips the import step, asks about search, then the folder", async () => {
  test.setTimeout(180_000);
  const launched = await launch(false);
  try {
    await passKey(launched.page);
    // #23: «Разрешить агенту искать в интернете?» — «Включить поиск»
    const search = launched.page.getByTestId("prsloy-first-run-search");
    await expect(search).toContainText("Разрешить агенту искать в интернете?", { timeout: 60_000 });
    await shot(launched.page, "web-search-7-first-run");
    await search.getByTestId("first-run-search-on").click();
    await expect(launched.page.getByTestId("prsloy-first-run-folder")).toBeVisible({
      timeout: 60_000,
    });
    await expect(launched.page.getByTestId("prsloy-import-choose")).toHaveCount(0);
  } finally {
    await launched.close();
  }
});
