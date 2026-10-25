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
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zipDirectory } from "../src/main/design/zip.ts";

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

function prepare(recording = "recorded.jsonl"): { root: string; bundle: string; venv: string } {
  const root = mkdtempSync(join(tmpdir(), "design-e2e-"));
  const bundle = join(root, "bundle");
  const harness = join(bundle, "playbooks", "site", "harness");
  mkdirSync(harness, { recursive: true });
  copyFileSync(join(FIXTURE, "fake_run.py"), join(harness, "run.py"));
  copyFileSync(join(FIXTURE, recording), join(harness, "recorded.jsonl"));
  cpSync(join(FIXTURE, "fixtures"), join(harness, "fixtures"), { recursive: true });
  for (const f of ["a6proxy.py", "stages.json"]) copyFileSync(join(HARNESS, f), join(harness, f));
  cpSync(join(FIXTURE, "stub-pipeline"), join(bundle, "design-pipeline"), { recursive: true });
  const venv = join(root, "venv");
  mkdirSync(join(venv, "bin"), { recursive: true });
  symlinkSync(python3, join(venv, "bin", "python"));
  return { root, bundle, venv };
}

async function launch(opts: {
  toolsReady: boolean;
  noBundle?: boolean;
  /** Public installers: harness shipped, private pipeline not. */
  noPipeline?: boolean;
  recording?: string;
}): Promise<Launched> {
  const prepared = prepare(opts.recording);
  const { root, venv } = prepared;
  if (opts.noPipeline) rmSync(join(prepared.bundle, "design-pipeline"), { recursive: true });
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
  const theme = process.env.DESIGN_E2E_THEME;
  if (locale || theme) {
    await page.evaluate(
      ([l, th]) => {
        if (l) localStorage.setItem("zeno.locale", l);
        if (th) localStorage.setItem("zeno.colorMode", th);
      },
      [locale, theme] as const,
    );
    await page.reload();
    await page.waitForSelector('[data-testid="zeno-app"][data-bootstrap-ready="true"]');
  }
  return { app, page, root };
}

async function shot(page: Page, name: string, settleMs = 250) {
  await page.waitForTimeout(settleMs);
  // DESIGN_E2E_THEME=dark → design-dark-<name>.png next to the light set.
  const theme = process.env.DESIGN_E2E_THEME;
  const suffix = theme && theme !== "light" ? `${theme}-` : "";
  await page.screenshot({ path: join(SCREENS, `design-${suffix}${name}.png`) });
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
    // no harness in the build at all: nothing to add a tools file to
    await expect(page.getByTestId("design-import-tools")).toHaveCount(0);
    await expect(page.getByTestId("design-setup")).toHaveCount(0);
    await expect(page.getByTestId("design-input")).toHaveCount(0);
    await expect(page.getByTestId("design-page")).not.toContainText(/Error|Traceback|ENOENT/);
    await shot(page, "unavailable");
  } finally {
    await app.close();
  }
});

test("a public build takes the owner's tools file and runs its first turn on it", async () => {
  const { app, page, root } = await launch({ toolsReady: true, noPipeline: true });
  try {
    // GitHub «Code → Download ZIP» of the stub pipeline, saved where an owner would keep it
    mkdirSync(join(root, "Загрузки"));
    const zip = join(root, "Загрузки", "design-pipeline-main.zip");
    writeFileSync(zip, zipDirectory(join(FIXTURE, "stub-pipeline"), "design-pipeline-main"));
    const junk = join(root, "Загрузки", "фото.jpg");
    writeFileSync(junk, "not a pipeline");
    const pickNext = (picked: string) =>
      app.evaluate(({ dialog }, p) => {
        Object.defineProperty(dialog, "showOpenDialog", {
          configurable: true,
          value: async () => ({ canceled: false, filePaths: [p] }),
        });
      }, picked);

    await page.getByTestId("nav-design").click();
    await expect(page.getByTestId("design-unavailable")).toBeVisible();
    const add = page.getByTestId("design-import-tools");
    await expect(add).toBeVisible();
    await shot(page, "import");
    await pickNext(junk);
    await add.click();
    await expect(page.getByTestId("design-import-error")).toHaveText(
      "Это не папка инструментов дизайна",
    );
    await expect(page.getByTestId("design-input")).toHaveCount(0);

    await pickNext(zip);
    await add.click();
    await expect(page.getByTestId("design-empty")).toBeVisible();
    const userData = await app.evaluate(({ app: a }) => a.getPath("userData"));
    const copy = join(userData, "design", "design-pipeline");
    expect(existsSync(join(copy, "tools", "flow.py"))).toBe(true);

    // first turn: run.py init starts from the copy the owner added
    await say(page, "сделай лендинг для кофейни «Зерно»");
    await expect(page.getByTestId("design-owner")).toHaveCount(1, { timeout: 30_000 });
    await expect(page.getByTestId("design-question-1")).toContainText("Для кого страница?");
    const stateDir = join(userData, "design-state");
    const state = JSON.parse(
      readFileSync(join(stateDir, readdirSync(stateDir)[0]!, "state.json"), "utf8"),
    ) as { pipeline: string };
    expect(state.pipeline).toBe(copy);
  } finally {
    await app.close();
  }
});

test("the step-1 card plays the candidate videos (prsloy-design://, Range)", async () => {
  const { app, page } = await launch({ toolsReady: true, recording: "recorded-moves.jsonl" });
  try {
    await page.getByTestId("nav-design").click();
    await say(page, "сделай лендинг для кофейни «Зерно»");
    const card = page.getByTestId("design-owner").first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByTestId("design-image")).toHaveCount(1);
    const videos = card.getByTestId("design-video");
    await expect(videos).toHaveCount(3);
    const video = videos.first();
    expect(await video.getAttribute("src")).toMatch(
      /^prsloy-design:\/\/ws\/[0-9a-f]{16}\/.+A\.mp4$/,
    );
    // metadata and the first frame really load: the protocol serves the mp4 the way <video> asks
    await expect
      .poll(() =>
        video.evaluate((el: HTMLVideoElement) => ({
          ready: el.readyState >= 2,
          w: el.videoWidth,
          long: el.duration > 1,
          error: el.error?.code ?? 0,
        })),
      )
      .toEqual({ ready: true, w: expect.any(Number), long: true, error: 0 });
    expect(await video.evaluate((el: HTMLVideoElement) => el.videoWidth)).toBeGreaterThan(100);
    // the same handler <video> streams through answers a byte range (asked from main: the page's CSP blocks fetch)
    const src = (await video.evaluate((el: HTMLVideoElement) => el.currentSrc)).split("#")[0]!;
    const ranged = await app.evaluate(async ({ net }, url) => {
      const res = await net.fetch(url, { headers: { range: "bytes=0-99" } });
      return { status: res.status, bytes: (await res.arrayBuffer()).byteLength };
    }, src);
    expect(ranged).toEqual({ status: 206, bytes: 100 });
    // it plays
    await video.evaluate((el: HTMLVideoElement) => el.play());
    await expect
      .poll(() => video.evaluate((el: HTMLVideoElement) => el.currentTime))
      .toBeGreaterThan(0.5);
    await shot(page, "videos");
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
    await expect(setup).toContainText("90");
    await expect(setup).toContainText("300");
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
    const zipPath = join(root, "Загрузки", "сайт.zip");
    mkdirSync(join(root, "Загрузки"));
    await app.evaluate(
      ({ dialog, shell }, { picked, zip }) => {
        const g = globalThis as typeof globalThis & { __opened?: string };
        Object.defineProperty(dialog, "showOpenDialog", {
          configurable: true,
          value: async () => ({ canceled: false, filePaths: [picked] }),
        });
        Object.defineProperty(dialog, "showSaveDialog", {
          configurable: true,
          value: async () => ({ canceled: false, filePath: zip }),
        });
        Object.defineProperty(shell, "openExternal", {
          configurable: true,
          value: async (u: string) =>
            void ((g as { __external?: string[] }).__external ??= []).push(u),
        });
        Object.defineProperty(shell, "openPath", {
          configurable: true,
          value: async (p: string) => {
            g.__opened = p;
            return "";
          },
        });
      },
      { picked: logo, zip: zipPath },
    );

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
    // a picture opens full size and closes again
    await img.click();
    await expect(page.getByTestId("image-preview-dialog")).toBeVisible();
    await shot(page, "image-full");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("image-preview-dialog")).toHaveCount(0);

    // turn 3: progress line while the harness works; the turn's stage budget runs out
    await card.getByTestId("design-recommend").click();
    await expect(page.getByTestId("design-user").nth(2)).toHaveText("как рекомендуешь");
    await expect(page.getByTestId("design-progress")).toBeVisible();
    await expect(page.getByTestId("design-progress-meta")).toContainText("1");
    // the raw tool calls sit under «Подробности», not in the owner's face
    await expect(page.getByTestId("design-ticker")).toHaveCount(0);
    await page.getByTestId("design-progress-details").click();
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
    // phone / desktop preview
    await page.getByTestId("design-device-phone").click();
    await expect(page.getByTestId("design-device-phone")).toHaveAttribute("aria-checked", "true");
    await expect
      .poll(() => frame.evaluate((el) => Math.round(el.getBoundingClientRect().width)))
      .toBeLessThanOrEqual(390);
    await shot(page, "done-phone", 400);
    await page.getByTestId("design-device-desktop").click();
    // «Открыть в браузере»: the system browser gets our own loopback preview address
    await page.getByTestId("design-open-browser").click();
    await expect
      .poll(() => app.evaluate(() => (globalThis as { __external?: string[] }).__external))
      .toEqual([await frame.getAttribute("src")]);
    // «Скачать архив»: site/ as a zip where the owner saved it
    await page.getByTestId("design-download-zip").click();
    await expect.poll(() => existsSync(zipPath)).toBe(true);
    const zip = readFileSync(zipPath);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    expect(zip.includes(Buffer.from("site/landing/index.html"))).toBe(true);
    // no project is open in this run (auto-resume is off): the workspace is Documents/PRSLOY
    const documents = await app.evaluate(({ app: a }) => a.getPath("documents"));
    await page.getByTestId("design-open-folder").click();
    await expect
      .poll(() => app.evaluate(() => (globalThis as { __opened?: string }).__opened))
      .toBe(join(documents, "PRSLOY", "prsloy-design", "site"));

    // «Настроить»: brand variables as handles, shown in the preview, saved only on «Сохранить»
    const pageFile = join(documents, "PRSLOY", "prsloy-design", "site", "landing", "index.html");
    const rootVar = (name: string) =>
      page
        .frameLocator('[data-testid="design-preview"]')
        .locator("html")
        .evaluate((el, n) => getComputedStyle(el).getPropertyValue(n).trim(), name);
    await page.getByTestId("design-tweak-open").click();
    const tweak = page.getByTestId("design-tweak");
    await expect(tweak).toBeVisible();
    await expect(tweak.getByTestId("design-tweak-radius")).toBeVisible();
    await tweak.getByTestId("design-tweak-radius-range").fill("20");
    await expect.poll(() => rootVar("--radius")).toBe("20px");
    expect(readFileSync(pageFile, "utf8")).toContain("--radius:12px");
    // the accent the colour of the background: refused, nothing to save
    await tweak.getByTestId("design-tweak-accent-f4ede1").click();
    await expect(tweak.getByTestId("design-tweak-error")).toHaveText(
      "Акцент потеряется на этом фоне",
    );
    await expect(tweak.getByTestId("design-tweak-save")).toBeDisabled();
    await tweak.getByTestId("design-tweak-accent-2b211b").click();
    await expect(tweak.getByTestId("design-tweak-error")).toHaveCount(0);
    await expect.poll(() => rootVar("--accent")).toBe("#2b211b");
    await shot(page, "tweak");
    await tweak.getByTestId("design-tweak-save").click();
    await expect(tweak).toHaveCount(0);
    expect(readFileSync(pageFile, "utf8")).toContain("--radius:20px");
    expect(readFileSync(pageFile, "utf8")).toContain("--accent:#2b211b");
    await expect.poll(() => rootVar("--radius")).toBe("20px");

    // «Править»: mark a place on the page, say what to change, the harness answers with before/after
    const preview = page.frameLocator('[data-testid="design-preview"]');
    await expect(preview.locator("[data-pl]")).toHaveCount(0);
    await page.getByTestId("design-edit-open").click();
    const edit = page.getByTestId("design-edit");
    await expect(edit.getByTestId("design-edit-hint")).toBeVisible();
    await expect(preview.locator("h1[data-pl]")).toHaveCount(1);
    await preview.locator("h1").click();
    await expect(edit.getByTestId("design-edit-place-1")).toHaveText("«Зерно»");
    await expect(edit.getByTestId("design-edit-apply")).toBeDisabled();
    // a second mark, then taken back
    await edit.getByTestId("design-edit-pick").click();
    await preview.locator("p.k").click();
    await expect(edit.getByTestId("design-edit-place-2")).toHaveText("«КОФЕЙНЯ»");
    await edit.getByTestId("design-edit-remove-2").click();
    await expect(edit.getByTestId("design-edit-place-2")).toHaveCount(0);
    await edit.getByTestId("design-edit-request-1").fill("крупнее, как вывеска");
    await shot(page, "edit");
    await edit.getByTestId("design-edit-apply").click();
    await expect(edit).toHaveCount(0);
    await expect(page.getByTestId("design-user").last()).toHaveText(
      "«Зерно» — крупнее, как вывеска",
    );
    const result = page.getByTestId("design-owner").last();
    await expect(result).toContainText("Сделал заголовок крупнее.");
    await expect(result.getByTestId("design-image")).toHaveCount(1);
    await expect(result.getByTestId("design-recommend")).toHaveCount(0);
    expect(readFileSync(pageFile, "utf8")).toContain("font-size:96px");
    const pins = JSON.parse(
      readFileSync(
        join(
          documents,
          "PRSLOY",
          "prsloy-design",
          "design",
          "landing",
          "artifacts",
          "edit",
          "01",
          "pins.json",
        ),
        "utf8",
      ),
    ) as { selector: string; file: string; line: number; request: string; width: number }[];
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({
      file: "site/landing/index.html",
      line: 1,
      request: "крупнее, как вывеска",
      width: 1440,
    });
    await shot(page, "edit-result");
    // «Вернуть как было»: the page from the copy before the edit; the owner sees the button's words
    await result.getByTestId("design-option-edit:revert:1").click();
    await expect(page.getByTestId("design-user").last()).toHaveText("Вернуть как было");
    await expect(page.getByTestId("design-done")).toBeVisible();
    await expect(page.getByTestId("design-done-past")).toHaveCount(1);
    expect(readFileSync(pageFile, "utf8")).toContain("font-size:64px");
    await expect(preview.locator("[data-pl]")).toHaveCount(0);

    // text without a model: a double click, type, Enter — written where the page says it is
    await page.getByTestId("design-edit-open").click();
    await expect(preview.locator("h1[data-pl]")).toHaveCount(1);
    // while picking, a double click is a pick (its first click), not a text edit
    await preview.locator("h1").dblclick();
    await expect(page.getByTestId("design-edit-place-1")).toHaveText("«Зерно»");
    await expect(preview.locator("[contenteditable]")).toHaveCount(0);
    const line = preview.locator("p", { hasText: "Обжариваем" });
    await line.dblclick();
    await expect(line).toHaveAttribute("contenteditable", "plaintext-only");
    await page.keyboard.type("Обжариваем сами, с рассветом.");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("design-edit-note")).toHaveText("Текст поменян.");
    expect(readFileSync(pageFile, "utf8")).toContain("<p>Обжариваем сами, с рассветом.</p>");
    expect(
      readFileSync(join(documents, "PRSLOY", "prsloy-design", "owner", "text-edits.jsonl"), "utf8"),
    ).toContain('"after":"Обжариваем сами, с рассветом."');
    await expect(preview.locator("p", { hasText: "с рассветом" })).toHaveCount(1);
    // a number the animation redraws: refused, the file stays
    await preview.locator("p.c").dblclick();
    await expect(page.getByTestId("design-edit-note")).toHaveText(
      "Этот текст двигает анимация — опишите правку словами.",
    );
    await shot(page, "edit-text");
    await page.getByTestId("design-edit-cancel").click();
    await expect(page.getByTestId("design-edit")).toHaveCount(0);
    expect(readFileSync(pageFile, "utf8")).toContain("data-move=count>180 ₽</p>");

    // the stream survives leaving and reopening the tab
    await page.getByTestId("nav-settings").click();
    await page.getByTestId("settings-back").click();
    await page.getByTestId("nav-design").click();
    await expect(page.getByTestId("design-owner")).toHaveCount(3);
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
