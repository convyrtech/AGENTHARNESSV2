/**
 * The novice's first hour, shared by features-first-hour.spec.ts (the happy hour) and
 * features-first-hour-bad.spec.ts (when things go wrong): a fresh computer, the real first run, the real
 * PRSLOY provider and harness, and a gateway that answers by script (first-hour-gateway.ts).
 */
import { expect, test, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import { appendFileSync, mkdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GOOD_KEY, scriptedGateway, type ScriptRule } from "./first-hour-gateway.ts";
import { shot as docsShot } from "./features-helpers.ts";

/**
 * Nightly (scripts/first-hour-nightly.mjs): with FIRST_HOUR_OUT set, screenshots go there instead of the docs,
 * and each one also records what a novice sees at that moment — the cards in the chat and the last reply — in
 * seen.jsonl, which the script turns into NOVICE.md («что видит новичок»).
 */
const OUT = process.env.FIRST_HOUR_OUT?.trim() || undefined;

export async function shot(page: Page, name: string): Promise<void> {
  if (!OUT) {
    await docsShot(page, name);
    return;
  }
  mkdirSync(join(OUT, "screens"), { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, "screens", `${name}.png`) });
  const seen = await page.evaluate(() => {
    const text = (el: Element) => (el as HTMLElement).innerText.replace(/\s+/gu, " ").trim();
    const cards = [
      ...document.querySelectorAll('[data-kind="system"], [data-testid="turn-status"]'),
    ]
      .map(text)
      .filter(Boolean);
    const dialog = document.querySelector('[role="dialog"], [role="alertdialog"]');
    // The reply without its trailing time («вс 20:56»).
    const replies = [...document.querySelectorAll('[data-kind="assistant"]')].map((el) =>
      text(el).replace(/\s+\S{2}\s+\d{1,2}:\d{2}$/u, ""),
    );
    return {
      title: document.querySelector("h1, h2")?.textContent?.trim() ?? "",
      cards: [...new Set(cards)].slice(0, 12),
      dialog: dialog ? text(dialog) : "",
      reply: replies.at(-1) ?? "",
    };
  });
  appendFileSync(
    join(OUT, "seen.jsonl"),
    `${JSON.stringify({ shot: name, test: test.info().title, ...seen })}\n`,
  );
}

const require = createRequire(import.meta.url);
const electronBinary = require("electron") as string;
const APP = join(dirname(fileURLToPath(import.meta.url)), "..");

export type Novice = {
  app: ElectronApplication;
  page: Page;
  project: string;
  agentDir: string;
  bodies: string[];
  close: () => Promise<void>;
};

/** A fresh computer: no key, no project. `flags` go to the harness flags file before the start. */
export async function launchNovice(
  rules: ScriptRule[],
  flags: Record<string, unknown> = {},
  extractor?: { ops: Record<string, unknown>[] },
  extraEnv: Record<string, string> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "prsloy-first-hour-"));
  const home = join(root, "home");
  const userData = join(root, "userData");
  // Main points PI_CODING_AGENT_DIR at userData/agent before ready (prsloy/agent-home.ts).
  const agentDir = join(userData, "agent");
  // Projects outside tmp: main never treats a /tmp folder as a project.
  const projects = await mkdtemp(join(homedir(), ".prsloy-first-hour-"));
  const project = join(projects, "Мой сайт");
  await Promise.all([
    mkdir(join(userData, "prsloy"), { recursive: true }),
    mkdir(agentDir, { recursive: true }),
    mkdir(project, { recursive: true }),
  ]);
  if (Object.keys(flags).length) {
    await writeFile(join(agentDir, "prsloy-harness.json"), JSON.stringify(flags));
  }
  const bodies: string[] = [];
  const server = scriptedGateway(rules, bodies, extractor);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await writeFile(
    join(userData, "prsloy", "state.json"),
    JSON.stringify({ baseUrl: `http://127.0.0.1:${port}/v1` }),
  );
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    ZENO_ISOLATED: "1",
    ZENO_NO_AUTO_RESUME: "1",
    LANG: "ru_RU.UTF-8",
    ...extraEnv,
  });
  for (const name of ["ELECTRON_RUN_AS_NODE", "ZENO_ENABLE_TEST_COMMANDS", "PI_CODING_AGENT_DIR"]) {
    delete env[name];
  }
  const app = await electron.launch({
    executablePath: electronBinary,
    args: [APP, `--user-data-dir=${userData}`, "--lang=ru", "--password-store=basic"],
    cwd: APP,
    env,
    timeout: 60_000,
  });
  const page = await app.firstWindow({ timeout: 60_000 });
  await page.setViewportSize({ width: 1280, height: 820 });
  const close = async () => {
    await app.close().catch(() => undefined);
    server.close();
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    await rm(projects, { recursive: true, force: true }).catch(() => undefined);
  };
  return { app, page, project, agentDir, bodies, close } satisfies Novice;
}

/** First run as a person does it: the key from the site, then «Выбрать папку». */
export async function firstRun(n: Novice) {
  const { page, app } = n;
  await expect(page.getByTestId("prsloy-first-run-key")).toBeVisible({ timeout: 60_000 });
  await page.getByPlaceholder("sk-…").fill(GOOD_KEY);
  await page.getByRole("button", { name: "Продолжить" }).click();
  await expect(page.getByTestId("prsloy-first-run-folder")).toBeVisible({ timeout: 60_000 });
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [folder],
    })) as unknown as typeof dialog.showOpenDialog;
  }, n.project);
  await page.getByTestId("prsloy-folder-pick").click();
  await page.waitForSelector('[data-testid="zeno-app"][data-bootstrap-ready="true"]', {
    timeout: 120_000,
  });
}

/** Sends a request and waits for the model's closing words (the end of the scripted turn). */
export async function ask(page: Page, text: string, reply: string) {
  await page.getByTestId("prompt-input").fill(text);
  await page.getByTestId("send-prompt").click();
  await expect(page.getByTestId("timeline")).toContainText(reply, { timeout: 90_000 });
  await page.waitForTimeout(800);
}

export const LIGHT = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>Анна Смирнова — фотограф</title>
<style>body { background: #ffffff; color: #222; font-family: sans-serif; margin: 3rem; }</style>
</head><body>
<h1>Анна Смирнова</h1>
<p>Фотограф. Свадьбы, портреты, семейные съёмки в Казани.</p>
<p>Телефон: +7 900 000-00-00</p>
</body></html>
`;
