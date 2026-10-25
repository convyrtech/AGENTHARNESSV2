/**
 * Layout lint: every key screen at a matrix of window sizes, Windows scales and both themes,
 * checked by code in the page (layout-rules.ts). Red on any violation not in layout-baseline.json.
 *
 *   pnpm --filter @zeno/desktop run build
 *   LAYOUT_OUT=/some/dir xvfb-run -a -s "-screen 0 2600x1500x24" pnpm --filter @zeno/desktop exec \
 *     playwright test -c playwright.audit.config.ts layout-lint
 *   node --experimental-strip-types apps/desktop/e2e-audit/layout-report.ts /some/dir
 *
 * Matrix: every window at 100 % and 150 %; 1280×720 and 1366×768 also at 125 % and 175 %.
 * A window is its size in physical pixels: the content gets size / scale CSS px (below the
 * app's minimum the window stays at the minimum, the check «window-min» says if it does not).
 * LAYOUT_SCALES=1,1.5 / LAYOUT_THEMES=dark / LAYOUT_FLOWS=code narrow a local run.
 *
 * Two launches per scale and theme: «code» — the real first run against a mock gateway (the
 * casual-audit path: key, folder, chat, preview, undo, errors, harness card, settings); «design» —
 * the «Дизайн» tab of a public build with the stub pipeline and the recorded run (no tools, empty,
 * a turn, the card with candidate videos).
 */
import { expect, test, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zipDirectory } from "../src/main/design/zip.ts";
import { excuse, parseBaseline, type Finding } from "./layout-baseline.ts";
import { GOOD_KEY, mockGateway } from "./layout-gateway.ts";
import { lintLayout, type Box, type LayoutViolation } from "./layout-rules.ts";

const require = createRequire(import.meta.url);
const electronBinary = require("electron") as string;
const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..");
const DESIGN_FIXTURE = join(APP, "e2e", "design");
const HARNESS = join(APP, "..", "..", "..", "playbooks", "site", "harness");
const OUT = process.env.LAYOUT_OUT ?? join(APP, "test-results", "layout");
const BASELINE = parseBaseline(
  JSON.parse(readFileSync(join(HERE, "layout-baseline.json"), "utf8")),
);
const TODAY = new Date().toISOString().slice(0, 10);

type Size = readonly [number, number];
const ALL_SIZES: Size[] = [
  [800, 600],
  [1024, 768],
  [1280, 720],
  [1366, 768],
  [1440, 900],
  [1920, 1080],
  [2560, 1440],
];
const LAPTOPS: Size[] = [
  [1280, 720],
  [1366, 768],
];
const MATRIX: { scale: number; sizes: Size[] }[] = [
  { scale: 1, sizes: ALL_SIZES },
  { scale: 1.25, sizes: LAPTOPS },
  { scale: 1.5, sizes: ALL_SIZES },
  { scale: 1.75, sizes: LAPTOPS },
];
const list = (name: string) => process.env[name]?.split(",").map((s) => s.trim()) ?? undefined;
const scales = list("LAYOUT_SCALES")?.map(Number);
const themes = list("LAYOUT_THEMES") ?? ["light", "dark"];
const flows = list("LAYOUT_FLOWS") ?? ["code", "design"];
const python3 = (() => {
  try {
    return execFileSync("sh", ["-c", "command -v python3"]).toString().trim();
  } catch {
    return "";
  }
})();

const sizeName = ([w, h]: Size) => `${w}×${h}`;

/** Checks one screen at every window size of the scale; leaves the window at the flow size. */
class Checker {
  readonly findings: Finding[] = [];
  private min: [number, number] = [0, 0];

  constructor(
    readonly app: ElectronApplication,
    readonly page: Page,
    readonly scale: number,
    readonly sizes: Size[],
    readonly theme: string,
    readonly flow: string,
  ) {}

  get tag() {
    return `${this.flow}-${Math.round(this.scale * 100)}-${this.theme}`;
  }

  /** The size the flow itself runs at: a 1366×768 laptop. */
  async home() {
    await this.resize([1366, 768]);
  }

  async resize([w, h]: Size): Promise<{ w: number; h: number }> {
    const target = { w: Math.round(w / this.scale), h: Math.round(h / this.scale) };
    this.min = (await this.app.evaluate(({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0]!;
      if (win.isMaximized()) win.unmaximize();
      win.setContentSize(size.w, size.h);
      return win.getMinimumSize() as [number, number];
    }, target)) as [number, number];
    // until the renderer has the new size (or the minimum held it) and two frames have passed
    let last = "";
    for (let i = 0; i < 40; i++) {
      const now = await this.page.evaluate(() => `${innerWidth}×${innerHeight}`);
      if (now === `${target.w}×${target.h}` || (now === last && i > 3)) break;
      last = now;
      await this.page.waitForTimeout(100);
    }
    await this.page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
    await this.page.waitForTimeout(150);
    return this.page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  }

  async check(screen: string) {
    const page = this.page;
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => {
      if (document.getElementById("layout-lint-freeze")) return;
      const style = document.createElement("style");
      style.id = "layout-lint-freeze";
      style.textContent =
        "*,*::before,*::after{transition-duration:0s!important;transition-delay:0s!important;animation-duration:0s!important;animation-delay:0s!important}";
      document.head.append(style);
    });
    for (const size of this.sizes) {
      const viewport = await this.resize(size);
      // Focus once per screen, at the laptop size, after a key press (keyboard modality).
      const checkFocus = size[0] === 1366 && size[1] === 768;
      if (checkFocus) await page.keyboard.press("Shift");
      const violations = await page.evaluate(lintLayout, {
        minWidth: this.min[0] || 760,
        minHeight: this.min[1] || 480,
        checkFocus,
      });
      if (violations.length === 0) continue;
      const shot = `${this.tag}-${screen}-${sizeName(size)}.png`;
      await frame(page, violations, join(OUT, "shots", shot));
      violations.forEach((v, i) =>
        this.findings.push({
          ...v,
          screen,
          size: sizeName(size),
          scale: this.scale,
          theme: this.theme,
          shot: `shots/${shot}`,
          n: i + 1,
          detail:
            viewport.w > Math.round(size[0] / this.scale) + 1
              ? `${v.detail} (окно держит минимум ${viewport.w}×${viewport.h})`
              : v.detail,
        }),
      );
    }
    await this.home();
  }

  /** Writes this launch's findings and fails on any the baseline does not excuse. */
  finish() {
    writeFileSync(
      join(OUT, `findings-${this.tag}.json`),
      `${JSON.stringify(this.findings, null, 2)}\n`,
    );
    const open = this.findings.filter((f) => !excuse(f, BASELINE, TODAY));
    const sample = open
      .slice(0, 15)
      .map((f) => `${f.rule} ${f.screen} ${f.size}: ${f.selector} «${f.text}» — ${f.detail}`)
      .join("\n");
    expect(open.length, `layout violations (first 15):\n${sample}`).toBe(0);
  }
}

/** Screenshot with a numbered red frame around each violation. */
async function frame(page: Page, violations: LayoutViolation[], path: string) {
  await page.evaluate(
    (boxes: Box[]) => {
      const layer = document.createElement("div");
      layer.id = "layout-lint-frames";
      layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647";
      boxes.forEach((b, i) => {
        const d = document.createElement("div");
        d.style.cssText = `position:absolute;left:${b.x - 2}px;top:${b.y - 2}px;width:${b.w + 4}px;height:${b.h + 4}px;outline:2px solid #ff0040;background:rgba(255,0,64,.08)`;
        const n = document.createElement("span");
        n.textContent = String(i + 1);
        n.style.cssText =
          "position:absolute;left:-2px;top:-15px;font:bold 11px/14px sans-serif;color:#fff;background:#ff0040;padding:0 3px";
        d.append(n);
        layer.append(d);
      });
      document.body.append(layer);
    },
    violations.map((v) => v.box),
  );
  await page.screenshot({ path });
  await page.evaluate(() => document.getElementById("layout-lint-frames")?.remove());
}

function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ZENO_ENABLE_TEST_COMMANDS;
  delete env.PI_CODING_AGENT_DIR;
  return env;
}

async function setTheme(page: Page, theme: string, ready: () => Promise<void>) {
  await page.evaluate((value) => localStorage.setItem("zeno.colorMode", value), theme);
  await page.reload();
  await ready();
}

/** The casual-audit path: first run, «Код», errors, harness card, «Дизайн» without a bundle, settings. */
async function codeFlow(scale: number, sizes: Size[], theme: string) {
  const root = await mkdtemp(join(tmpdir(), "prsloy-layout-"));
  const home = join(root, "home");
  const userData = join(root, "userData");
  const projects = await mkdtemp(join(homedir(), ".prsloy-layout-"));
  const project = join(projects, "vizitka");
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(join(userData, "prsloy"), { recursive: true }),
    mkdir(project, { recursive: true }),
  ]);
  const server = mockGateway();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  writeFileSync(
    join(userData, "prsloy", "state.json"),
    JSON.stringify({ baseUrl: `http://127.0.0.1:${port}/v1` }),
  );
  const env = Object.assign(baseEnv(), {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    ZENO_ISOLATED: "1",
    ZENO_NO_AUTO_RESUME: "1",
    LANG: "ru_RU.UTF-8",
    DESIGN_BUNDLE_DIR: join(root, "no-design-bundle"),
  });
  const app = await electron.launch({
    executablePath: electronBinary,
    args: [
      APP,
      `--user-data-dir=${userData}`,
      "--lang=ru",
      "--password-store=basic",
      `--force-device-scale-factor=${scale}`,
    ],
    cwd: APP,
    env,
    timeout: 60_000,
  });
  const page = await app.firstWindow({ timeout: 60_000 });
  const c = new Checker(app, page, scale, sizes, theme, "code");
  try {
    await c.home();
    const keyScreen = () =>
      expect(page.getByTestId("prsloy-first-run-key")).toBeVisible({ timeout: 60_000 });
    await keyScreen();
    await setTheme(page, theme, keyScreen);
    await c.check("first-run-key");
    const input = page.getByPlaceholder("sk-…");
    await input.fill("sk-wrong");
    await page.getByRole("button", { name: "Продолжить" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await c.check("first-run-wrong-key");
    await input.fill(GOOD_KEY);
    await page.getByRole("button", { name: "Продолжить" }).click();
    await expect(page.getByTestId("prsloy-first-run-folder")).toBeVisible({ timeout: 60_000 });
    await c.check("first-run-folder");
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [folder],
      })) as unknown as typeof dialog.showOpenDialog;
    }, project);
    await page.getByTestId("prsloy-folder-pick").click();
    await page.waitForSelector('[data-testid="zeno-app"][data-bootstrap-ready="true"]', {
      timeout: 120_000,
    });
    await page.waitForTimeout(1500);
    await c.check("code-empty");

    const send = async (text: string) => {
      await page.getByTestId("prompt-input").fill(text);
      await page.getByTestId("send-prompt").click();
    };
    await send("Сделай сайт-визитку для флориста");
    await expect(page.getByTestId("turn-preview-btn")).toBeVisible({ timeout: 90_000 });
    await c.check("code-turn");
    await page.getByTestId("turn-preview-btn").click();
    await expect(page.getByTestId("code-preview-frame")).toBeVisible();
    await c.check("code-preview");
    await page.getByTestId("code-preview-close").click();
    await page.getByTestId("turn-undo-btn").click();
    await expect(page.getByTestId("turn-undo-confirm")).toBeVisible();
    await c.check("dialog-undo-confirm");
    await page.getByTestId("turn-undo-confirm").getByRole("button", { name: "Откатить" }).click();
    await expect(page.getByTestId("turn-undo-result")).toBeVisible();
    await c.check("code-undo-done");

    for (const [name, text] of [
      ["error-balance", "Проверим, хватит ли денег"],
      ["error-key", "Проверим ключ"],
      ["error-break", "Проверим обрыв связи"],
      ["error-model", "Проверим, что модель есть"],
    ] as const) {
      const failures = await page.getByTestId("model-failure").count();
      await send(text);
      await expect
        .poll(() => page.getByTestId("model-failure").count(), { timeout: 120_000 })
        .toBeGreaterThan(failures);
      await expect(page.getByTestId("turn-progress")).toBeHidden({ timeout: 120_000 });
      await page.waitForTimeout(1000);
      await c.check(name);
    }
    await send("Проверим сбой разметки");
    await expect(page.getByTestId("harness-card")).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId("turn-progress")).toBeHidden({ timeout: 120_000 });
    await c.check("code-harness-card");

    await page.getByTestId("nav-design").click();
    await expect(page.getByTestId("design-unavailable")).toBeVisible();
    await c.check("design-unavailable");

    await page.keyboard.press("Control+,");
    await expect(page.getByTestId("settings-general")).toBeVisible();
    const sections = await page
      .locator('[data-testid^="settings-nav-"]')
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-testid") ?? ""));
    for (const id of sections) {
      await page.getByTestId(id).click();
      await page.waitForTimeout(300);
      await c.check(id.replace("settings-nav-", "settings-"));
    }
  } finally {
    await app.close().catch(() => undefined);
    server.close();
    await rm(projects, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
  c.finish();
}

/** «Дизайн» of a public build: no tools → the owner adds the stub pipeline → a turn → videos. */
async function designFlow(scale: number, sizes: Size[], theme: string) {
  const root = await mkdtemp(join(tmpdir(), "prsloy-layout-design-"));
  const bundle = join(root, "bundle");
  const harness = join(bundle, "playbooks", "site", "harness");
  mkdirSync(harness, { recursive: true });
  copyFileSync(join(DESIGN_FIXTURE, "fake_run.py"), join(harness, "run.py"));
  copyFileSync(join(DESIGN_FIXTURE, "recorded-moves.jsonl"), join(harness, "recorded.jsonl"));
  cpSync(join(DESIGN_FIXTURE, "fixtures"), join(harness, "fixtures"), { recursive: true });
  for (const f of ["a6proxy.py", "stages.json"]) copyFileSync(join(HARNESS, f), join(harness, f));
  const venv = join(root, "venv");
  mkdirSync(join(venv, "bin"), { recursive: true });
  symlinkSync(python3, join(venv, "bin", "python"));
  const home = join(root, "home");
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  const userData = join(root, "userData");
  mkdirSync(userData, { recursive: true });
  const downloads = join(root, "Загрузки");
  mkdirSync(downloads);
  const zip = join(downloads, "design-pipeline-main.zip");
  writeFileSync(zip, zipDirectory(join(DESIGN_FIXTURE, "stub-pipeline"), "design-pipeline-main"));
  const env = Object.assign(baseEnv(), {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
    ZENO_NO_AUTO_RESUME: "1",
    ZENO_ENABLE_TEST_COMMANDS: "1",
    LANG: "ru_RU.UTF-8",
    DESIGN_BUNDLE_DIR: bundle,
    PRSLOY_DESIGN_PI_BIN: '["true"]',
    PRSLOY_API_KEY: "e2e-key-not-secret",
    PRSLOY_BASE_URL: "http://127.0.0.1:9/v1",
    PRSLOY_DESIGN_VENV: venv,
  });
  const app = await electron.launch({
    executablePath: electronBinary,
    args: [APP, `--user-data-dir=${userData}`, "--lang=ru", `--force-device-scale-factor=${scale}`],
    cwd: APP,
    env,
    timeout: 60_000,
  });
  const page = await app.firstWindow({ timeout: 60_000 });
  const c = new Checker(app, page, scale, sizes, theme, "design");
  try {
    await c.home();
    const ready = async () => {
      await page.waitForSelector('[data-testid="zeno-app"][data-bootstrap-ready="true"]', {
        timeout: 120_000,
      });
    };
    await ready();
    await setTheme(page, theme, ready);
    await page.getByTestId("nav-design").click();
    await expect(page.getByTestId("design-import-tools")).toBeVisible();
    await c.check("design-no-tools");
    await app.evaluate(({ dialog }, picked) => {
      Object.defineProperty(dialog, "showOpenDialog", {
        configurable: true,
        value: async () => ({ canceled: false, filePaths: [picked] }),
      });
    }, zip);
    await page.getByTestId("design-import-tools").click();
    await expect(page.getByTestId("design-empty")).toBeVisible({ timeout: 30_000 });
    await c.check("design-empty");
    await page.getByTestId("design-input").fill("сделай лендинг для кофейни «Зерно»");
    await page.getByTestId("design-send").click();
    const card = page.getByTestId("design-owner").first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByTestId("design-video")).toHaveCount(3);
    await expect
      .poll(() =>
        card
          .getByTestId("design-video")
          .first()
          .evaluate((el: HTMLVideoElement) => el.readyState >= 2),
      )
      .toBe(true);
    await c.check("design-turn-videos");
  } finally {
    await app.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
  c.finish();
}

test.beforeAll(() => mkdirSync(join(OUT, "shots"), { recursive: true }));

for (const { scale, sizes } of MATRIX) {
  if (scales && !scales.includes(scale)) continue;
  for (const theme of themes) {
    const pct = Math.round(scale * 100);
    if (flows.includes("code")) {
      test(`code screens at ${pct}% (${theme})`, () => codeFlow(scale, sizes, theme));
    }
    if (flows.includes("design")) {
      test(`design screens at ${pct}% (${theme})`, async () => {
        test.skip(!python3 || process.platform === "win32", "needs python3 (Linux)");
        await designFlow(scale, sizes, theme);
      });
    }
  }
}
