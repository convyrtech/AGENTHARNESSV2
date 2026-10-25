/**
 * «Дизайн» on a real run: the conductor's 8-turn run (e2e/design/fixtures/ab-run-2026-10-25,
 * 2 h 56 min, 877 events) replayed through e2e/design/replay_run.py with time sped up, as the
 * owner would see it. DESIGN_REPLAY_SHOTS=<dir> also saves a screenshot of each state there.
 */
import { expect, test, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startClip } from "../e2e-screens/clip-recorder.ts";

const require = createRequire(import.meta.url);
const electronBinary = require("electron") as string;
const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..");
const FIXTURE = join(HERE, "design");
const HARNESS = join(APP, "..", "..", "..", "playbooks", "site", "harness");
const SHOTS = process.env.DESIGN_REPLAY_SHOTS;
const python3 = (() => {
  try {
    return execFileSync("sh", ["-c", "command -v python3"]).toString().trim();
  } catch {
    return "";
  }
})();

type Launched = { app: ElectronApplication; page: Page; root: string };

type Replay = { speed?: number; turnEnd?: number; silence?: boolean };

async function launch(replay: Replay = {}): Promise<Launched> {
  const root = mkdtempSync(join(tmpdir(), "design-replay-"));
  const bundle = join(root, "bundle");
  const harness = join(bundle, "playbooks", "site", "harness");
  mkdirSync(harness, { recursive: true });
  copyFileSync(join(FIXTURE, "replay_run.py"), join(harness, "run.py"));
  // the real run.py, for its options_of / doing_of (the fixture predates both)
  copyFileSync(join(HARNESS, "run.py"), join(harness, "real_run.py"));
  // main passes run.py an allowlisted env, so the replay reads its settings from a file
  writeFileSync(join(harness, "replay.json"), JSON.stringify(replay));
  cpSync(join(FIXTURE, "fixtures"), join(harness, "fixtures"), { recursive: true });
  for (const f of ["a6proxy.py", "stages.json"]) copyFileSync(join(HARNESS, f), join(harness, f));
  cpSync(join(FIXTURE, "stub-pipeline"), join(bundle, "design-pipeline"), { recursive: true });
  const venv = join(root, "venv");
  mkdirSync(join(venv, "bin"), { recursive: true });
  symlinkSync(python3, join(venv, "bin", "python"));
  const home = join(root, "home");
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  const all: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) all[k] = v;
  delete all.ELECTRON_RUN_AS_NODE;
  Object.assign(all, {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
    ZENO_NO_AUTO_RESUME: "1",
    ZENO_ENABLE_TEST_COMMANDS: "1",
    DESIGN_BUNDLE_DIR: bundle,
    PRSLOY_DESIGN_PI_BIN: '["true"]',
    PRSLOY_API_KEY: "e2e-key-not-secret",
    PRSLOY_BASE_URL: "http://127.0.0.1:9/v1",
    PRSLOY_DESIGN_VENV: venv,
  });
  const userData = join(root, "userData");
  mkdirSync(userData, { recursive: true });
  const app = await electron.launch({
    executablePath: electronBinary,
    args: [APP, `--user-data-dir=${userData}`, "--lang=ru"],
    cwd: APP,
    env: all,
    timeout: 60_000,
  });
  const page = await app.firstWindow({ timeout: 60_000 });
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.waitForSelector('[data-testid="zeno-app"][data-bootstrap-ready="true"]', {
    timeout: 120_000,
  });
  await page.evaluate(() => localStorage.setItem("zeno.locale", "ru"));
  await page.reload();
  await page.waitForSelector('[data-testid="zeno-app"][data-bootstrap-ready="true"]');
  await page.getByTestId("nav-design").click();
  return { app, page, root };
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

async function say(page: Page, text: string) {
  await page.getByTestId("design-input").fill(text);
  await page.getByTestId("design-send").click();
}

/** What the owner answered in the recording (turns.jsonl), turn by turn. */
const ANSWERS = [
  "привет, сделай лендинг для нашего апи сервиса PRSLOY, чтоб было круто. домен prsloy.online",
  "а а а",
  "как рекомендуешь",
  "да, только главное что работает из россии без впн",
  "да",
  "а",
  "а",
];

test.describe.configure({ mode: "serial" });
test.skip(!python3 || process.platform === "win32", "needs python3 (Linux e2e)");

test("the real run, turn by turn, as the owner sees it", async () => {
  test.setTimeout(600_000);
  const { app, page, root } = await launch({ speed: SHOTS ? 60 : 400 });
  try {
    for (const [i, answer] of ANSWERS.entries()) {
      const turn = i + 1;
      const owners = await page.getByTestId("design-owner").count();
      if (turn === 6) {
        // run.py's word option: the button sends its key as the answer, nothing else
        await page
          .getByTestId("design-owner")
          .last()
          .getByRole("button", { name: /^Берём его/u })
          .click();
        await expect(page.getByTestId("design-user").last()).toHaveText("Берём его");
      } else {
        await say(page, answer);
      }
      await expect(page.getByTestId("design-progress")).toBeVisible({ timeout: 30_000 });
      if (turn === 7) {
        // The long step: 80 minutes, 321 tool calls. One plain line, the step and time left;
        // the raw calls only under «Подробности».
        const step = page.getByTestId("design-progress-step");
        await expect(page.getByTestId("design-progress-meta")).toContainText("Шаг 7 из 8", {
          timeout: 120_000,
        });
        // run.py's own words for the action, or the step's: plain Russian, never a command
        await expect(step).toHaveText(/^[А-ЯЁ][а-яё]+/u);
        await page.waitForTimeout(SHOTS ? 20_000 : 2_000);
        const meta = page.getByTestId("design-progress-meta");
        await expect(meta).toContainText("Шаг 7 из 8");
        await expect(meta).toContainText(/осталось|дольше обычного/);
        await expect(page.getByTestId("design-progress-time")).toContainText("мин");
        await expect(page.getByTestId("design-ticker")).toHaveCount(0);
        await expect(page.getByText(/^bash /)).toHaveCount(0);
        await shot(page, "replay-turn7-running");
        if (SHOTS) {
          // the waiting line on a long step, for docs/prsloy/screens/theme-design-step.mp4
          const box = (await page.getByTestId("design-progress").boundingBox())!;
          const stop = await startClip(page, join(SHOTS, "theme-design-step.mp4"), {
            x: Math.round(box.x),
            y: Math.round(box.y) - 8,
            width: Math.round(box.width / 2) * 2,
            height: Math.round(box.height / 2) * 2 + 16,
          });
          await page.waitForTimeout(4_000);
          await stop();
        }
        await page.getByTestId("design-progress-details").click();
        await expect(page.getByTestId("design-ticker").locator("li")).toHaveCount(8);
        await shot(page, "replay-turn7-details");
        await page.getByTestId("design-progress-details").click();
      } else if (turn === 1) {
        await page.waitForTimeout(SHOTS ? 3_000 : 500);
        await shot(page, "replay-turn1-running");
      }
      if (turn === 7) {
        // turn 7 ends on a note, not a question: the owner continues it
        await expect(page.getByTestId("design-progress")).toBeHidden({ timeout: 300_000 });
      } else {
        await expect(page.getByTestId("design-owner")).toHaveCount(owners + 1, {
          timeout: 300_000,
        });
      }
      if (turn === 3) {
        // «Всё верно, можно дальше?» comes with run.py's own answer buttons
        const card = page.getByTestId("design-owner").last();
        await expect(card.getByTestId("design-option-да")).toContainText("Да");
        await expect(card.getByTestId("design-option-да")).toContainText("рекомендую");
        await expect(card.getByTestId("design-option-нет")).toHaveText("Нет, поправить");
        await expect(card.getByTestId("design-recommend")).toBeVisible();
      }
      await shot(page, `replay-turn${turn}-done`);
    }
  } finally {
    await app.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a long silence reads as thinking; «Остановить» asks, then says what happened", async () => {
  test.setTimeout(180_000);
  // The first turn stops after six events, four minutes ago on the harness clock.
  const { app, page, root } = await launch({ turnEnd: 6, silence: true });
  try {
    await say(page, ANSWERS[0]!);
    const step = page.getByTestId("design-progress-step");
    await expect(step).toHaveText("Думаю над шагом…", { timeout: 30_000 });
    await expect(page.getByTestId("design-progress-meta")).toContainText("Шаг 1 из 8");
    await shot(page, "replay-silence");

    // four minutes in: «Остановить» asks first, the answer is plain
    await page.getByTestId("design-stop-step").click();
    const confirm = page.getByTestId("design-stop-confirm");
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText("Сделанное сохранится, продолжить можно позже.");
    await shot(page, "replay-stop-confirm");
    await confirm.getByRole("button", { name: "Не останавливать" }).click();
    await expect(confirm).toBeHidden();
    await expect(page.getByTestId("design-progress")).toBeVisible();

    await page.getByTestId("design-stop-step").click();
    await confirm.getByRole("button", { name: "Остановить" }).click();
    const cancelled = page.getByTestId("design-cancelled");
    await expect(cancelled).toBeVisible({ timeout: 30_000 });
    await expect(cancelled).toContainText("Остановил. Сделанное сохранено.");
    await expect(page.getByTestId("design-continue")).toBeVisible();
    await expect(page.getByTestId("design-progress")).toHaveCount(0);
    await shot(page, "replay-stopped");
  } finally {
    await app.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});
