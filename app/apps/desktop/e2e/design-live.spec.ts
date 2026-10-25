/**
 * «Дизайн» live: the real app, the real run.py and a6proxy, the real tools on a real venv. Only pi is a stand-in
 * (e2e/design/live_pi.py): it runs its bash calls through the agent shell (Git Bash on Windows), so `python3` goes
 * through the app's shims, moves.py drives Edge (channel=msedge on Windows) and check.py checks the page.
 * The gateway is a local fake that passes every second-opinion check. The pipeline is the stub, imported the way
 * an owner does it: the pinned-commit zip through «У меня есть файл инструментов».
 *
 * DESIGN_LIVE_VENV — venv with the design tools (scripts/design-smoke.mts makes one; locally any venv with pillow,
 * numpy, playwright + chromium, imageio-ffmpeg). Without it the file is skipped.
 * DESIGN_LIVE_SHOTS — folder for screenshots (CI uploads it; default: the test's output folder).
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
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
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
const REPO = join(APP, "..", "..", "..");
const VENV = process.env.DESIGN_LIVE_VENV ?? "";
const WIN = process.platform === "win32";
const VENV_PY = WIN ? join(VENV, "Scripts", "python.exe") : join(VENV, "bin", "python");
const SHA = "39fcac42db4bd344c7d9747a5903cc18c9d87718";
const CHECKS = [
  "lang",
  "casual",
  "one_question",
  "no_empty",
  "no_broken",
  "no_dupes",
  "no_screens",
  "consistent",
  "no_stubs",
];

test.describe.configure({ mode: "serial" });
test.skip(!VENV, "DESIGN_LIVE_VENV: a venv with the design tools");
test.setTimeout(600_000);

/** Fake gateway behind the app's a6proxy: every second-opinion check passes. */
let gateway: Server;
let gatewayUrl = "";
test.beforeAll(async () => {
  gateway = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const text = CHECKS.map((k) => `${k} | да | не применимо`).join("\n");
      const body = JSON.stringify({
        choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
        usage: { prompt_tokens: 900, completion_tokens: 60 },
      });
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      });
      res.end(body);
    });
  });
  await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", r));
  const addr = gateway.address();
  gatewayUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/v1`;
});
test.afterAll(() => gateway?.close());

type Lab = { root: string; profile: string; userData: string; downloads: string };

let current: Lab | undefined;
/** On failure: the harness ledger, pi sessions, live_pi's bash log and the tab's events next to the screenshots. */
test.afterEach(async () => {
  const info = test.info();
  if (!current || info.status === info.expectedStatus) return;
  const name = info.title.replace(/[^\w]+/g, "-").slice(0, 60);
  const out = join(process.env.DESIGN_LIVE_SHOTS || info.outputDir, "diag", name);
  const grab = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const rel of readdirSync(dir, { recursive: true }) as string[]) {
      const from = join(dir, rel);
      const st = statSync(from);
      if (!st.isFile() || st.size > 2 << 20 || /\.(png|mp4|webm)$/.test(rel)) continue;
      mkdirSync(out, { recursive: true });
      copyFileSync(from, join(out, rel.replace(/[\\/:]+/g, "__")));
    }
  };
  grab(join(current.userData, "design-state"));
  grab(join(current.userData, "design", "pi-agent"));
  grab(join(current.userData, "design", "logs"));
});

/** Public-build bundle (harness, motion; no pipeline) and an owner profile with a Cyrillic name. */
function lab(): Lab {
  const root = mkdtempSync(join(tmpdir(), "design-live-"));
  const made = (l: Lab) => (current = l);
  const bundle = join(root, "bundle");
  for (const dir of [
    ["playbooks", "site", "harness"],
    ["playbooks", "site", "motion"],
  ]) {
    cpSync(join(REPO, ...dir), join(bundle, ...dir), {
      recursive: true,
      filter: (p) => !p.includes("__pycache__") && !p.endsWith(".mp4"),
    });
  }
  const profile = join(root, "Иван Петров");
  const downloads = join(profile, "Downloads");
  mkdirSync(downloads, { recursive: true });
  writeFileSync(
    join(downloads, `design-pipeline-${SHA}.zip`),
    zipDirectory(join(FIXTURE, "stub-pipeline"), `design-pipeline-${SHA}`),
  );
  return made({ root, profile, userData: join(profile, "AppData", "PRSLOY"), downloads });
}

async function launch(l: Lab): Promise<{ app: ElectronApplication; page: Page }> {
  const home = join(l.root, "home");
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  mkdirSync(l.userData, { recursive: true });
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env.ELECTRON_RUN_AS_NODE;
  Object.assign(env, {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
    ZENO_NO_AUTO_RESUME: "1",
    ZENO_ENABLE_TEST_COMMANDS: "1",
    DESIGN_BUNDLE_DIR: join(l.root, "bundle"),
    PRSLOY_DESIGN_HOME: join(l.profile, "Documents", "PRSLOY"),
    PRSLOY_DESIGN_VENV: VENV,
    PRSLOY_DESIGN_PI_BIN: JSON.stringify([VENV_PY, join(FIXTURE, "live_pi.py")]),
    PRSLOY_API_KEY: "e2e-key-not-secret",
    PRSLOY_BASE_URL: gatewayUrl,
  });
  const app = await electron.launch({
    executablePath: electronBinary,
    args: [APP, `--user-data-dir=${l.userData}`],
    cwd: APP,
    env,
    timeout: 60_000,
  });
  const page = await app.firstWindow({ timeout: 60_000 });
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.waitForSelector('[data-testid="zeno-app"][data-bootstrap-ready="true"]', {
    timeout: 120_000,
  });
  return { app, page };
}

async function shot(page: Page, name: string) {
  const dir = process.env.DESIGN_LIVE_SHOTS || test.info().outputDir;
  mkdirSync(dir, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(dir, `design-${WIN ? "windows" : "live"}-${name}.png`) });
}

/** The owner adds the pinned-commit zip; the tab becomes the empty design page. */
async function importTools(app: ElectronApplication, page: Page, l: Lab) {
  const zip = join(l.downloads, `design-pipeline-${SHA}.zip`);
  await app.evaluate(({ dialog }, p) => {
    Object.defineProperty(dialog, "showOpenDialog", {
      configurable: true,
      value: async () => ({ canceled: false, filePaths: [p] }),
    });
  }, zip);
  await page.getByTestId("nav-design").click();
  await page.getByTestId("design-import-tools").click();
  await expect(page.getByTestId("design-empty")).toBeVisible();
}

async function say(page: Page, text: string) {
  await page.getByTestId("design-input").fill(text);
  await page.getByTestId("design-send").click();
}

const ws = (l: Lab) => join(l.profile, "Documents", "PRSLOY", "prsloy-design");
const piHome = (l: Lab) => join(l.userData, "design", "pi-agent");
const ownerLines = (l: Lab) =>
  readFileSync(join(ws(l), "owner", "messages.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean).length;

/** Processes still running anything of this lab: harness, pi stand-in, python tools, the tools' browser. */
function leftovers(l: Lab): string[] {
  const rows: { pid: number; cmd: string }[] = WIN
    ? (
        JSON.parse(
          execFileSync(
            "powershell",
            [
              "-NoProfile",
              "-Command",
              "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
            ],
            { encoding: "utf8", maxBuffer: 64 << 20 },
          ),
        ) as { ProcessId: number; CommandLine: string | null }[]
      ).map((p) => ({ pid: p.ProcessId, cmd: p.CommandLine ?? "" }))
    : execFileSync("ps", ["-ww", "-eo", "pid=,args="], { encoding: "utf8" })
        .split("\n")
        .map((s) => /^\s*(\d+)\s+(.*)$/.exec(s))
        .filter((m): m is RegExpExecArray => !!m)
        .map((m) => ({ pid: Number(m[1]), cmd: m[2]! }));
  const marks = [l.root, "live_pi.py", "moves.py", "browser_hold.py", "a6proxy.py"];
  // the tools' browser and its children (zygote, gpu, renderers carry --headless, not the pipe flag)
  const browser = (cmd: string) =>
    cmd.includes("--remote-debugging-pipe") ||
    (/msedge|chrome|headless[-_]shell/i.test(cmd) && cmd.includes("--headless"));
  return rows
    .filter((r) => r.pid !== process.pid)
    .filter((r) => marks.some((m) => r.cmd.includes(m)) || browser(r.cmd))
    .map((r) => `${r.pid} ${r.cmd}`);
}

test("a full turn on the real tools: sheet and videos, choice «A», the page", async () => {
  const l = lab();
  const { app, page } = await launch(l);
  try {
    await importTools(app, page, l);
    await say(page, "Сделай лендинг для кофейни «Зерно»");
    const card = page.getByTestId("design-owner").first();
    await expect(card).toBeVisible({ timeout: 300_000 });
    const videos = card.getByTestId("design-video");
    await expect(videos).toHaveCount(3);
    // all three load on this machine's browser (Edge on Windows) and stop seeking to the poster frame
    await expect
      .poll(() =>
        videos.evaluateAll((els: HTMLVideoElement[]) =>
          els.map((el) => el.readyState >= 2 && el.duration > 1 && !el.seeking && !el.error),
        ),
      )
      .toEqual([true, true, true]);
    await expect(card.getByTestId("design-image")).toHaveCount(1);
    await shot(page, "videos");
    // diagnostics for the poster: the mp4 files themselves and the card without native controls
    const dir = process.env.DESIGN_LIVE_SHOTS || test.info().outputDir;
    for (const k of ["A", "B", "C"]) {
      copyFileSync(
        join(ws(l), "design", "landing", "01-cands", `${k}.mp4`),
        join(dir, `design-${WIN ? "windows" : "live"}-${k}.mp4`),
      );
    }
    await videos.evaluateAll((els: HTMLVideoElement[]) =>
      els.forEach((el) => (el.controls = false)),
    );
    await shot(page, "videos-nocontrols");
    await videos.evaluateAll((els: HTMLVideoElement[]) =>
      els.forEach((el) => (el.controls = true)),
    );

    // the agent shell ran python3 from the app's shim: the venv's interpreter, full stdlib
    const probe = readFileSync(join(piHome(l), "live-probe.txt"), "utf8");
    expect(probe).toMatch(/^1 /);
    expect(probe.trim().slice(2).toLowerCase()).toContain(
      VENV.toLowerCase().replaceAll("\\", "/").split("/").pop()!,
    );
    expect(probe).not.toMatch(/WindowsApps/i);

    // harness state under userData, user-only
    const stateRoot = join(l.userData, "design-state");
    const state = join(stateRoot, readdirSync(stateRoot)[0]!);
    if (WIN) {
      const acl = execFileSync("icacls", [state], { encoding: "utf8" });
      expect(acl).not.toMatch(/Everyone|BUILTIN\\Users|Authenticated Users|Все|Пользователи/);
      expect(acl).toMatch(/\(OI\)\(CI\)\(F\)|\(F\)/);
      test.info().annotations.push({ type: "icacls", description: acl.trim() });
    } else {
      expect(statSync(state).mode & 0o777).toBe(0o700);
    }

    // choice «A» → the next turn: pick, the page, check.py, done
    await card.getByTestId("design-option-A").click();
    await expect(page.getByTestId("design-done")).toBeVisible({ timeout: 300_000 });
    await expect(page.frameLocator('[data-testid="design-preview"]').locator("h1")).toHaveText(
      "Зерно",
    );
    expect(existsSync(join(ws(l), "design", "landing", "01-pack.json"))).toBe(true);
    expect(ownerLines(l)).toBe(2);
    await shot(page, "done");
  } finally {
    await app.close();
  }
});

test("closing the app mid-turn leaves no processes; «Продолжить» finishes the turn once", async () => {
  const l = lab();
  let { app, page } = await launch(l);
  try {
    await importTools(app, page, l);
    // a tool holding the tools' browser: bash → python → Edge (Chromium on Linux)
    mkdirSync(piHome(l), { recursive: true });
    writeFileSync(join(piHome(l), "live-control.json"), JSON.stringify({ hold: 300 }));
    await say(page, "Сделай лендинг для кофейни «Зерно»");
    await expect(page.getByTestId("design-ticker")).toContainText("browser_hold.py", {
      timeout: 120_000,
    });
    await expect
      .poll(() => leftovers(l).some((r) => r.includes("--remote-debugging-pipe")), {
        timeout: 60_000,
      })
      .toBe(true);
    const during = leftovers(l);
    test.info().annotations.push({
      type: "processes before close",
      description: during.map((r) => r.slice(0, 200)).join("\n"),
    });
    await app.close();
    await expect.poll(() => leftovers(l), { timeout: 30_000 }).toEqual([]);

    ({ app, page } = await launch(l));
    await page.getByTestId("nav-design").click();
    await expect(page.getByTestId("design-interrupted")).toBeVisible();
    await expect(page.getByTestId("design-continue")).toHaveCount(1);
    await shot(page, "interrupted");
    await page.getByTestId("design-continue").click();
    await expect(page.getByTestId("design-owner")).toHaveCount(1, { timeout: 300_000 });
    await expect(page.getByTestId("design-user")).toHaveCount(1);
    await expect(page.getByTestId("design-continue")).toHaveCount(0);
    expect(ownerLines(l)).toBe(1);
  } finally {
    await app.close();
  }
});

test("pi dying mid-step: «stuck» in plain words, «Повторить» works", async () => {
  const l = lab();
  const { app, page } = await launch(l);
  try {
    await importTools(app, page, l);
    mkdirSync(piHome(l), { recursive: true });
    writeFileSync(join(piHome(l), "live-control.json"), JSON.stringify({ crash: 99 }));
    await say(page, "Сделай лендинг для кофейни «Зерно»");
    // every rung of the ladder dies: the turn's stage budget runs out, then the ladder is spent
    await expect(page.getByTestId("design-paused")).toBeVisible({ timeout: 120_000 });
    await page.getByTestId("design-continue").click();
    const stuck = page.getByTestId("design-stuck");
    await expect(stuck).toBeVisible({ timeout: 120_000 });
    await expect(stuck).not.toContainText(/Traceback|Error|exit/);
    await shot(page, "stuck");
    writeFileSync(join(piHome(l), "live-control.json"), JSON.stringify({ crash: 0 }));
    await page.getByTestId("design-retry").click();
    await expect(page.getByTestId("design-owner")).toHaveCount(1, { timeout: 300_000 });
    await expect(page.getByTestId("design-owner").first().getByTestId("design-video")).toHaveCount(
      3,
    );
  } finally {
    await app.close();
  }
});
