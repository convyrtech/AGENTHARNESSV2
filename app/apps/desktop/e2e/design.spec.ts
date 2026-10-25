/**
 * «Дизайн» tab end to end (Linux): the real app, main service and a6proxy, with run.py
 * replaced by e2e/design/fake_run.py replaying a log recorded from the real run.py.
 * Screenshots of each state go to docs/prsloy/screens/design-*.png.
 *
 * DESIGN_E2E_LOCALE picks the UI language (default: the app's own default).
 */
import { expect, test, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const electronBinary = require("electron") as string;
const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..");
const FIXTURE = join(HERE, "design");
const HARNESS = join(APP, "..", "..", "..", "playbooks", "site", "harness");
const SCREENS = join(APP, "..", "..", "docs", "prsloy", "screens");
const python3 = (() => {
  try {
    return execFileSync("sh", ["-c", "command -v python3"]).toString().trim();
  } catch {
    return "";
  }
})();

type Launched = { app: ElectronApplication; page: Page; root: string };

function prepare(): { root: string; bundle: string; venv: string } {
  const root = mkdtempSync(join(tmpdir(), "design-e2e-"));
  const bundle = join(root, "bundle");
  const harness = join(bundle, "playbooks", "site", "harness");
  mkdirSync(harness, { recursive: true });
  copyFileSync(join(FIXTURE, "fake_run.py"), join(harness, "run.py"));
  copyFileSync(join(FIXTURE, "recorded.jsonl"), join(harness, "recorded.jsonl"));
  cpSync(join(FIXTURE, "fixtures"), join(harness, "fixtures"), { recursive: true });
  for (const f of ["a6proxy.py", "stages.json"]) copyFileSync(join(HARNESS, f), join(harness, f));
  cpSync(join(FIXTURE, "stub-pipeline"), join(bundle, "design-pipeline"), { recursive: true });
  const venv = join(root, "venv");
  mkdirSync(join(venv, "bin"), { recursive: true });
  symlinkSync(python3, join(venv, "bin", "python"));
  return { root, bundle, venv };
}

async function launch(opts: { toolsReady: boolean; noBundle?: boolean }): Promise<Launched> {
  const prepared = prepare();
  const { root, venv } = prepared;
  // a build made without the private design-pipeline ships no design bundle at all
  const bundle = opts.noBundle ? join(root, "no-design-bundle") : prepared.bundle;
  const home = join(root, "home");
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env.ELECTRON_RUN_AS_NODE;
  Object.assign(env, {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
    ZENO_NO_AUTO_RESUME: "1",
    ZENO_ENABLE_TEST_COMMANDS: "1",
    DESIGN_BUNDLE_DIR: bundle,
    PRSLOY_DESIGN_PI_BIN: '["true"]',
    PRSLOY_API_KEY: "e2e-key-not-secret",
    PRSLOY_BASE_URL: "http://127.0.0.1:9/v1",
    ...(opts.toolsReady ? { PRSLOY_DESIGN_VENV: venv } : {}),
  });
  const userData = join(root, "userData");
  mkdirSync(userData, { recursive: true });
  const app = await electron.launch({
    executablePath: electronBinary,
    args: [APP, `--user-data-dir=${userData}`],
    cwd: APP,
    env,
    timeout: 60_000,
  });
  const page = await app.firstWindow({ timeout: 60_000 });
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.waitForSelector('[data-testid="zeno-app"][data-bootstrap-ready="true"]', {
    timeout: 120_000,
  });
  const locale = process.env.DESIGN_E2E_LOCALE;
  if (locale) {
    await page.evaluate((l) => localStorage.setItem("zeno.locale", l), locale);
    await page.reload();
    await page.waitForSelector('[data-testid="zeno-app"][data-bootstrap-ready="true"]');
  }
  return { app, page, root };
}

async function shot(page: Page, name: string, settleMs = 250) {
  await page.waitForTimeout(settleMs);
  await page.screenshot({ path: join(SCREENS, `design-${name}.png`) });
}

async function say(page: Page, text: string) {
  await page.getByTestId("design-input").fill(text);
  await page.getByTestId("design-send").click();
}

test.describe.configure({ mode: "serial" });
test.skip(!python3 || process.platform === "win32", "needs python3 (Linux e2e)");

test("a build without the design bundle shows one calm state", async () => {
  const { app, page } = await launch({ toolsReady: false, noBundle: true });
  try {
    await page.getByTestId("nav-design").click();
    await expect(page.getByTestId("design-unavailable")).toBeVisible();
    await expect(page.getByTestId("design-setup")).toHaveCount(0);
    await expect(page.getByTestId("design-input")).toHaveCount(0);
    await expect(page.getByTestId("design-page")).not.toContainText(/Error|Traceback|ENOENT/);
    await shot(page, "unavailable");
  } finally {
    await app.close();
  }
});

test("first use offers the one-time tools setup", async () => {
  const { app, page } = await launch({ toolsReady: false });
  try {
    await page.getByTestId("nav-design").click();
    const setup = page.getByTestId("design-setup");
    await expect(setup).toBeVisible();
    await expect(setup).toContainText("62");
    await expect(page.getByTestId("design-setup-start")).toBeEnabled();
    await expect(page.getByTestId("design-input")).toHaveCount(0);
    await shot(page, "setup");
  } finally {
    await app.close();
  }
});

test("owner leads a landing page from request to preview", async () => {
  const { app, page, root } = await launch({ toolsReady: true });
  try {
    const logo = join(root, "logo.png");
    copyFileSync(join(FIXTURE, "fixtures", "logo.png"), logo);
    await app.evaluate(({ dialog, shell }, picked) => {
      const g = globalThis as typeof globalThis & { __opened?: string };
      Object.defineProperty(dialog, "showOpenDialog", {
        configurable: true,
        value: async () => ({ canceled: false, filePaths: [picked] }),
      });
      Object.defineProperty(shell, "openPath", {
        configurable: true,
        value: async (p: string) => {
          g.__opened = p;
          return "";
        },
      });
    }, logo);

    await page.getByTestId("nav-design").click();
    await expect(page.getByTestId("design-empty")).toBeVisible();
    await shot(page, "empty");

    // turn 1: two questions, one button row each
    await say(page, "сделай лендинг для кофейни «Зерно»");
    await expect(page.getByTestId("design-user")).toHaveCount(1);
    const first = page.getByTestId("design-owner").first();
    await expect(first.getByTestId("design-question-1")).toContainText("Для кого страница?");
    await expect(first.getByTestId("design-question-2")).toContainText("Что главное");
    await expect(first).not.toContainText("1. Для кого");
    const answer = first.getByTestId("design-answer");
    await expect(answer).toBeDisabled();
    await first.getByTestId("design-question-1").getByTestId("design-option-А").click();
    await first.getByTestId("design-question-2").getByTestId("design-option-А").click();
    await expect(answer).toBeEnabled();
    await shot(page, "questions");

    // turn 2: the logo goes with the button answer; a choice with a picture comes back
    await page.getByTestId("design-attach").click();
    await expect(page.getByTestId("design-attachments")).toContainText("logo.png");
    await answer.click();
    await expect(page.getByTestId("design-user").nth(1)).toContainText("1А 2А");
    await expect(page.getByTestId("design-user").nth(1)).toContainText("logo.png");
    await expect(page.getByTestId("design-owner")).toHaveCount(2);
    const card = page.getByTestId("design-owner").last();
    await expect(card.getByTestId("design-option-A")).toBeVisible();
    await expect(card.getByTestId("design-option-C")).toBeVisible();
    await expect(card.getByTestId("design-answer")).toHaveCount(0);
    const img = card.getByTestId("design-image");
    await expect(img).toBeVisible();
    await expect
      .poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth))
      .toBe(480);
    expect(await img.getAttribute("src")).toMatch(/^prsloy-design:\/\/ws\/[0-9a-f]{16}\//);
    await expect(card).not.toContainText("00-moods.png");
    await expect(first.getByTestId("design-options")).toHaveCount(0);
    await shot(page, "choice");

    // turn 3: progress line while the harness works; the turn's stage budget runs out
    await card.getByTestId("design-recommend").click();
    await expect(page.getByTestId("design-user").nth(2)).toHaveText("как рекомендуешь");
    await expect(page.getByTestId("design-progress")).toBeVisible();
    await expect(page.getByTestId("design-progress-step")).toContainText("1");
    await expect(page.getByTestId("design-ticker")).toHaveText(/\w/);
    await expect(page.getByTestId("design-stop")).toBeVisible();
    await shot(page, "progress", 0);
    await expect(page.getByTestId("design-paused")).toBeVisible({ timeout: 30_000 });

    // turn 4: continue → every rung of the ladder failed → stuck
    await page.getByTestId("design-continue").click();
    await expect(page.getByTestId("design-stuck")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("design-progress")).toHaveCount(0);
    await shot(page, "stuck");

    // retry → finished page in the sandboxed preview
    await page.getByTestId("design-retry").click();
    await expect(page.getByTestId("design-done")).toBeVisible({ timeout: 30_000 });
    const frame = page.getByTestId("design-preview");
    await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    await expect(frame).toHaveAttribute("src", /^http:\/\/127\.0\.0\.1:\d+\/landing\/$/);
    await expect(page.frameLocator('[data-testid="design-preview"]').locator("h1")).toHaveText(
      "Зерно",
    );
    await shot(page, "done");
    // no project is open in this run (auto-resume is off): the workspace is Documents/PRSLOY
    const documents = await app.evaluate(({ app: a }) => a.getPath("documents"));
    await page.getByTestId("design-open-folder").click();
    await expect
      .poll(() => app.evaluate(() => (globalThis as { __opened?: string }).__opened))
      .toBe(join(documents, "PRSLOY", "prsloy-design", "site"));

    // the stream survives leaving and reopening the tab
    await page.getByTestId("nav-settings").click();
    await page.getByTestId("settings-back").click();
    await page.getByTestId("nav-design").click();
    await expect(page.getByTestId("design-owner")).toHaveCount(2);
    await expect(page.getByTestId("design-done")).toBeVisible();

    // stop a long turn
    await say(page, "долго");
    await expect(page.getByTestId("design-progress")).toBeVisible();
    await page.getByTestId("design-stop").click();
    await expect(page.getByTestId("design-cancelled")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("design-continue")).toBeVisible();
  } finally {
    await app.close();
  }
});
