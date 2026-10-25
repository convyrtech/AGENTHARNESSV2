/**
 * «Дизайн» live: the real app, the real run.py and a6proxy, the real tools on a real venv. Only pi is a stand-in
 * (e2e/design/live_pi.py): it runs its bash calls through the agent shell (Git Bash on Windows), so `python3` goes
 * through the app's shims, moves.py drives Edge (channel=msedge on Windows) and check.py checks the page.
 * The gateway is a local fake that passes every second-opinion check. The pipeline is the stub, imported the way
 * an owner does it: the pinned-commit zip through «У меня есть файл инструментов».
 *
 * DESIGN_LIVE_VENV — venv with the design tools (scripts/design-smoke.mts makes one; locally any venv with pillow,
 * numpy, playwright + chromium, imageio-ffmpeg). Without it the file is skipped.
 * DESIGN_LIVE_EXE — an installed PRSLOY.exe (the owner's NSIS package) instead of the dev build: its own design
 * bundle, the tools set up through the tab's first-use setup, the profile «Иван Петров» through USERPROFILE/APPDATA.
 * DESIGN_LIVE_SHOTS — folder for screenshots (CI uploads it; default: the test's output folder).
 */
import { expect, test, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
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
// only the dev build needs the electron package's binary; the installed-app job does not download it
const electronBinary = () => require("electron") as string;
const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..");
const FIXTURE = join(HERE, "design");
const REPO = join(APP, "..", "..", "..");
const VENV = process.env.DESIGN_LIVE_VENV ?? "";
const EXE = process.env.DESIGN_LIVE_EXE ?? "";
/** Dev build without a given venv: the app sets its tools up itself, as on first use (the first-use test). */
const FIRSTUSE = process.env.DESIGN_LIVE_FIRSTUSE === "1";
const WIN = process.platform === "win32";
const VENV_PY = WIN ? join(VENV, "Scripts", "python.exe") : join(VENV, "bin", "python");
const SHA = "39fcac42db4bd344c7d9747a5903cc18c9d87718";
/** What the live PRSLOY gateway served on 2026-10-25: no deepseek, no kimi from the stages.json ladder. */
const OWNER_SITE = `<!doctype html><html lang=ru><head><meta charset=utf-8><title>Зерно</title><style>
body{margin:0;background:#f3eee3;color:#3b2a1e;font:18px/1.5 Georgia,serif}.b{background:#a4472c;color:#fff;
border-radius:10px;padding:12px 20px;display:inline-block}</style></head><body><h1>Зерно</h1>
<p>Обжариваем сами, каждое утро. Завтраки и выпечка в центре города.</p><a class=b href=#>Заказать</a></body></html>`;
const LIVE_MODELS = ["qwen3.8-max", "claude-opus-5-5", "claude-fable-5", "gpt-6.1-sol", "grok-4.7"];
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
test.skip(
  !VENV && !EXE && !FIRSTUSE,
  "DESIGN_LIVE_VENV (dev build), DESIGN_LIVE_EXE (installed app) or DESIGN_LIVE_FIRSTUSE=1",
);
test.setTimeout(600_000);

/** Fake gateway behind the app's a6proxy: every second-opinion check passes. */
let gateway: Server;
let gatewayUrl = "";
test.beforeAll(async () => {
  gateway = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.method === "GET" && req.url === "/site/") {
        // the owner's own site: «бренд по адресу сайта» reads its colours and fonts
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(OWNER_SITE);
        return;
      }
      if (req.method === "GET" && req.url?.endsWith("/models")) {
        const list = JSON.stringify({ data: LIVE_MODELS.map((id) => ({ id })) });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(list);
        return;
      }
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
  // the dev build gets a public-build bundle (harness, motion; no pipeline); the installed app ships its own
  for (const dir of EXE
    ? []
    : [
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
  return made({
    root,
    profile,
    userData: join(profile, "AppData", "Roaming", "PRSLOY"),
    downloads,
  });
}

async function launch(
  l: Lab,
  /** Extra env for this launch (the no-network run points the proxy at a closed port). */
  extra: Record<string, string> = {},
  drop: string[] = [],
): Promise<{ app: ElectronApplication; page: Page }> {
  const home = join(l.root, "home");
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  mkdirSync(l.userData, { recursive: true });
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    // runner credentials never reach the app under test
    if (v === undefined || /TOKEN|SECRET|PASSWORD|^AWS_|^CSC_|^ACTIONS_/i.test(k)) continue;
    env[k] = v;
  }
  delete env.ELECTRON_RUN_AS_NODE;
  // the venv the app makes on first use (installed) or the one given (dev)
  const python = VENV
    ? VENV_PY
    : WIN
      ? join(l.userData, "design", "venv", "Scripts", "python.exe")
      : join(l.userData, "design", "venv", "bin", "python");
  Object.assign(env, {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
    ZENO_NO_AUTO_RESUME: "1",
    ZENO_ENABLE_TEST_COMMANDS: "1",
    PRSLOY_DESIGN_PI_BIN: JSON.stringify([python, join(FIXTURE, "live_pi.py")]),
    PRSLOY_API_KEY: "e2e-key-not-secret",
    PRSLOY_BASE_URL: gatewayUrl,
  });
  if (EXE) {
    // the installed app: its own bundle and first-use setup; a user «Иван Петров» on Windows
    for (const k of Object.keys(env))
      if (/^(DESIGN_BUNDLE_DIR|PRSLOY_DESIGN_(VENV|HOME))$/i.test(k)) delete env[k];
    if (WIN) {
      const local = join(l.profile, "AppData", "Local");
      for (const dir of [
        "Documents",
        "Desktop",
        join("AppData", "Roaming"),
        join("AppData", "Local", "Temp"),
      ]) {
        mkdirSync(join(l.profile, dir), { recursive: true });
      }
      for (const k of Object.keys(env)) {
        if (/^(USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|TEMP|TMP)$/i.test(k))
          delete env[k];
      }
      Object.assign(env, {
        USERPROFILE: l.profile,
        HOMEDRIVE: l.profile.slice(0, 2),
        HOMEPATH: l.profile.slice(2),
        APPDATA: join(l.profile, "AppData", "Roaming"),
        LOCALAPPDATA: local,
        TEMP: join(local, "Temp"),
        TMP: join(local, "Temp"),
      });
    }
  } else {
    Object.assign(env, {
      DESIGN_BUNDLE_DIR: join(l.root, "bundle"),
      PRSLOY_DESIGN_HOME: join(l.profile, "Documents", "PRSLOY"),
      PRSLOY_DESIGN_VENV: VENV,
    });
  }
  for (const k of Object.keys(env)) if (drop.includes(k.toUpperCase())) delete env[k];
  Object.assign(env, extra);
  const app = await electron.launch({
    executablePath: EXE || electronBinary(),
    args: [...(EXE ? [] : [APP]), `--user-data-dir=${l.userData}`],
    cwd: EXE ? l.profile : APP,
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
  const tag = EXE ? "windows-installed" : WIN ? "windows" : "live";
  await page.screenshot({ path: join(dir, `design-${tag}-${name}.png`) });
}

/** The file picker answers with this path. */
async function pickFile(app: ElectronApplication, path: string) {
  await app.evaluate(({ dialog }, p) => {
    Object.defineProperty(dialog, "showOpenDialog", {
      configurable: true,
      value: async () => ({ canceled: false, filePaths: [p] }),
    });
  }, path);
}

/** The owner adds the pinned-commit zip; the tab becomes the empty design page. */
async function importTools(app: ElectronApplication, page: Page, l: Lab) {
  await pickFile(app, join(l.downloads, `design-pipeline-${SHA}.zip`));
  await page.getByTestId("nav-design").click();
  // a public build: harness shipped, pipeline not — the owner adds his zip
  await page.getByTestId("design-import-tools").click();
  if (!VENV) {
    // first use: the tab sets up its Python tools (bundled Python → venv → wheels → browser)
    await expect(page.getByTestId("design-setup")).toBeVisible();
    if ((await page.getByTestId("design-setup-start").count()) > 0) {
      await page.getByTestId("design-setup-start").click();
    }
    await expect(page.getByTestId("design-setup")).toHaveCount(0, { timeout: 600_000 });
  }
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

/** Size of a folder on disk, MB (the venv after first use). */
function folderMb(dir: string): number {
  let bytes = 0;
  if (!existsSync(dir)) return 0;
  for (const rel of readdirSync(dir, { recursive: true }) as string[]) {
    // lstat: a Linux venv has lib64 → lib, followed it would count everything twice
    const st = lstatSync(join(dir, rel), { throwIfNoEntry: false });
    if (st?.isFile()) bytes += st.size;
  }
  return Math.round(bytes / 1024 / 1024);
}

type Sample = { t: number; phase: string; text: string; loader: boolean };

/** What the owner sees while the tools set up: the card's phase and text twice a second until it is gone. */
async function watchSetup(page: Page, limitMs = 600_000): Promise<Sample[]> {
  const t0 = Date.now();
  const samples: Sample[] = [];
  while (Date.now() - t0 < limitMs) {
    const card = page.getByTestId("design-setup");
    if ((await card.count()) === 0) break;
    const phase = (await card.getAttribute("data-phase").catch(() => null)) ?? "gone";
    const text = ((await card.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
    const loader = (await page.getByTestId("design-setup-loader").count()) > 0;
    samples.push({ t: Date.now() - t0, phase, text, loader });
    if (phase === "error") break;
    await page.waitForTimeout(500);
  }
  return samples;
}

/** The longest stretch with the same visible text and no moving bar: «silence» for the owner. */
function longestStill(samples: Sample[]): number {
  let best = 0;
  let from = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!;
    const b = samples[i]!;
    // a running line loader moves on its own: not silence
    if (b.text !== a.text || b.loader) from = b.t;
    best = Math.max(best, b.t - from);
  }
  return best;
}

test("first use: a zip that is not the design tools is refused in plain words", async () => {
  const l = lab();
  const notes = join(l.root, "notes");
  mkdirSync(notes, { recursive: true });
  writeFileSync(join(notes, "README.md"), "# Мои заметки\n");
  const zip = join(l.downloads, "notes-main.zip");
  writeFileSync(zip, zipDirectory(notes, "notes-main"));
  const { app, page } = await launch(l);
  try {
    await pickFile(app, zip);
    await page.getByTestId("nav-design").click();
    await page.getByTestId("design-import-tools").click();
    await expect(page.getByTestId("design-import-error")).toContainText("не");
    await expect(page.getByTestId("design-import-error")).not.toContainText(/Error|at |\\|\//);
    // the owner can try again with the right file
    await expect(page.getByTestId("design-import-tools")).toBeVisible();
    await shot(page, "firstuse-wrong-zip");
  } finally {
    await app.close();
  }
});

test("first use on the installed app: no network → plain words and «Повторить»; then the tools set up with progress, measured", async () => {
  test.skip(
    !EXE && !FIRSTUSE,
    "first-use setup: the installed app, or the dev build with DESIGN_LIVE_FIRSTUSE=1",
  );
  const l = lab();
  const report: Record<string, unknown> = { profile: l.profile };
  // 1) no network while the tools download: pip goes through a proxy on a closed port
  {
    const dead = "http://127.0.0.1:9";
    const { app, page } = await launch(
      l,
      { HTTPS_PROXY: dead, HTTP_PROXY: dead, https_proxy: dead, http_proxy: dead },
      ["NO_PROXY"],
    );
    try {
      await pickFile(app, join(l.downloads, `design-pipeline-${SHA}.zip`));
      await page.getByTestId("nav-design").click();
      await page.getByTestId("design-import-tools").click();
      await expect(page.getByTestId("design-setup")).toBeVisible();
      if ((await page.getByTestId("design-setup-start").count()) > 0)
        await page.getByTestId("design-setup-start").click();
      const samples = await watchSetup(page, 300_000);
      const last = samples.at(-1);
      expect(last?.phase, JSON.stringify(samples.slice(-3))).toBe("error");
      await expect(page.getByTestId("design-setup-error")).toContainText("Нет связи");
      await expect(page.getByTestId("design-setup-start")).toBeVisible();
      report.offline = { seconds: Math.round((last?.t ?? 0) / 1000), error: last?.text };
      await shot(page, "firstuse-no-network");
    } finally {
      await app.close();
    }
  }
  // 2) the network is back: «Повторить» sets the tools up; what the owner sees is sampled the whole time
  const { app, page } = await launch(l);
  try {
    await page.getByTestId("nav-design").click();
    await expect(page.getByTestId("design-setup")).toBeVisible();
    const t0 = Date.now();
    await page.getByTestId("design-setup-start").click();
    const samples = await watchSetup(page);
    const seconds = Math.round((Date.now() - t0) / 1000);
    await expect(page.getByTestId("design-empty")).toBeVisible();
    const phases = [...new Set(samples.map((x) => x.phase))];
    const firstAt = Object.fromEntries(
      phases.map((ph) => [ph, Math.round(samples.find((x) => x.phase === ph)!.t / 1000)]),
    );
    const still = longestStill(samples);
    Object.assign(report, {
      setupSeconds: seconds,
      phases: firstAt,
      longestStillSeconds: Math.round(still / 1000),
      venvMb: folderMb(join(l.userData, "design", "venv")),
      designMb: folderMb(join(l.userData, "design")),
      texts: [...new Set(samples.map((x) => x.text))].slice(0, 12),
    });
    // progress, not silence: every sample shows a phase in words and a moving bar until it is done
    expect(
      samples.every((x) => x.loader && x.text.length > 0),
      JSON.stringify(samples.slice(0, 5)),
    ).toBe(true);
    // the failed offline try already made the venv: the retry may go straight to the download
    expect(phases).toContain("browser");
    expect(phases.some((ph) => ph === "download" || ph === "install")).toBe(true);
    await shot(page, "firstuse-ready");

    // 3) the first «Сделай лендинг…»: the step 1 card
    const t1 = Date.now();
    await say(page, "Сделай лендинг для кофейни «Зерно»");
    await expect(page.getByTestId("design-owner").first()).toBeVisible({ timeout: 300_000 });
    report.firstCardSeconds = Math.round((Date.now() - t1) / 1000);
    await shot(page, "firstuse-step1");
  } finally {
    await app.close();
    const dir = process.env.DESIGN_LIVE_SHOTS || test.info().outputDir;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "firstuse.json"), JSON.stringify(report, null, 2));
  }
});

test("a full turn on the real tools: sheet and videos, choice «A», the page", async () => {
  const l = lab();
  const { app, page } = await launch(l);
  try {
    await importTools(app, page, l);
    const site = gatewayUrl.replace(/\/v1$/, "/site/");
    await say(page, `Сделай лендинг для кофейни «Зерно», наш сайт ${site}`);
    const card = page.getByTestId("design-owner").first();
    await expect(card).toBeVisible({ timeout: 300_000 });
    const videos = card.getByTestId("design-video");
    await expect(videos).toHaveCount(3);
    // all three load and play on this machine's browser (Edge on Windows)
    await expect
      .poll(() =>
        videos.evaluateAll((els: HTMLVideoElement[]) =>
          els.map((el) => el.readyState >= 2 && el.duration > 1 && !el.paused && !el.error),
        ),
      )
      .toEqual([true, true, true]);
    await expect(card.getByTestId("design-image")).toHaveCount(1);
    await shot(page, "videos");

    // the brand of the owner's site, measured before the turn: no model
    // (the installed package is main's latest build, which may predate this branch)
    if (!EXE) {
      const brandFile = join(ws(l), "materials", "brand.json");
      const brand = JSON.parse(readFileSync(brandFile, "utf8")) as {
        colors: Record<string, string>;
        fonts: { body: { family: string } };
        radius: string;
      };
      expect(brand.colors).toEqual({ background: "#f3eee3", text: "#3b2a1e", accent: "#a4472c" });
      expect(brand.fonts.body.family).toBe("Georgia");
      expect(brand.radius).toBe("10px");
    }

    // check.py holds the page to the brand's colours: its brand_check.py is in the workspace (dev build until merged)
    if (!EXE) expect(existsSync(join(ws(l), "harness", "brand_check.py"))).toBe(true);

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

    // red marks on the sheet go with the answer (dev build until merged): main lays them over the picture
    if (!EXE) {
      await card.getByTestId("design-image").click();
      const canvas = page.getByTestId("design-marks-canvas");
      const box = (await canvas.boundingBox())!;
      await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.45, { steps: 8 });
      await page.mouse.up();
      await page.getByTestId("design-marks-attach").click();
      await expect(page.getByTestId("design-attachments")).toContainText("marks-");
    }

    // choice «A» → the next turn: pick, the page, check.py, done
    // the buttons came from the ask_owner call, not from the text (dev build until merged)
    if (!EXE) {
      await expect(card.getByTestId("design-option-A")).toContainText("Кольцо и счётчик");
      await expect(card.getByTestId("design-option-A")).toContainText("рекомендую");
      await expect(card).toContainText("Какое движение берём?");
      const sent = readdirSync(join(state, "sent"));
      expect(readFileSync(join(state, "sent", sent.at(-1)!), "utf8")).toContain(
        "A. Кольцо и счётчик (рекомендую)",
      );
    }
    await card.getByTestId("design-option-A").click();
    await expect(page.getByTestId("design-done")).toBeVisible({ timeout: 300_000 });
    await expect(page.frameLocator('[data-testid="design-preview"]').locator("h1")).toHaveText(
      "Зерно",
    );
    expect(existsSync(join(ws(l), "design", "landing", "01-pack.json"))).toBe(true);
    expect(ownerLines(l)).toBe(2);
    // the ladder follows the gateway's /v1/models: the first stage runs on qwen, nothing on deepseek or kimi
    const stages = readFileSync(join(state, "ledger.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((x) => JSON.parse(x) as { kind: string; model?: string })
      .filter((x) => x.kind === "stage");
    test
      .info()
      .annotations.push({ type: "first stage model", description: String(stages[0]?.model) });
    // the installed exe is main's latest build: it follows the gateway's list once the change is merged
    if (!EXE) {
      expect(stages[0]?.model).toBe("a6p/qwen3.8-max");
      expect(stages.every((x) => LIVE_MODELS.includes(x.model!.split("/")[1]!))).toBe(true);
    }
    // the turn with the marks: the real run.py told the agent what red is and gave the turn to a model that sees
    if (!EXE) {
      expect(
        readdirSync(join(ws(l), "materials")).some((n) =>
          /^marks-01-candidates-\d{6}\.png$/.test(n),
        ),
      ).toBe(true);
      expect(stages.at(-1)?.model).toBe("a6p/claude-opus-5-5");
      const briefs = readdirSync(join(state, "sessions"))
        .filter((n) => n.endsWith(".brief.md"))
        .map((n) => readFileSync(join(state, "sessions", n), "utf8"));
      expect(briefs.some((b) => b.includes("пометки владельца, не дизайн"))).toBe(true);
    }
    // run.py's learning events: next to the «Код» harness's, kinds and numbers only — none of the owner's words
    const learn = readFileSync(
      join(l.root, "home", ".pi", "agent", "prsloy-learning", "design-events.jsonl"),
      "utf8",
    );
    expect(learn.split("\n").filter(Boolean).length).toBeGreaterThan(2);
    expect(learn).not.toMatch(/Зерно|кофейн|Сделай/);
    await shot(page, "done");

    // «Править» (dev build only until it is on main): a mark on the page, the real run.py edit turn — shots before
    // and after in this machine's browser, the sheet, «Оставить» recommended when only the marked place changed
    if (!EXE) {
      const preview = page.frameLocator('[data-testid="design-preview"]');
      await page.getByTestId("design-edit-open").click();
      await preview.locator("h1").click();
      await expect(page.getByTestId("design-edit-place-1")).toHaveText("«Зерно»");
      await page.getByTestId("design-edit-request-1").fill("заголовок цветом акцента");
      await page.getByTestId("design-edit-apply").click();
      const result = page.getByTestId("design-owner").last();
      await expect(result).toContainText("Заголовок теперь в цвете акцента", { timeout: 300_000 });
      await expect(result.getByTestId("design-image")).toHaveCount(1);
      await expect(result.getByTestId("design-option-edit:keep:1")).toContainText("рекомендую");
      await expect(result).not.toContainText("кроме выбранного");
      const edit = join(ws(l), "design", "landing", "artifacts", "edit", "01");
      for (const f of ["pins.json", "before-1440.png", "after-1440.png", "sheet-1440.png"]) {
        expect(existsSync(join(edit, f)), f).toBe(true);
      }
      const pins = JSON.parse(readFileSync(join(edit, "pins.json"), "utf8")) as {
        file?: string;
        request: string;
      }[];
      expect(pins).toMatchObject([
        { file: "site/landing/index.html", request: "заголовок цветом акцента" },
      ]);
      await shot(page, "edit-result");
      await result.getByTestId("design-option-edit:keep:1").click();
      await expect(page.getByTestId("design-user").last()).toHaveText("Оставить");
      await expect(page.getByTestId("design-done")).toBeVisible({ timeout: 60_000 });
      const html = readFileSync(join(ws(l), "site", "landing", "index.html"), "utf8");
      expect(html).toContain("<h1 style='color:#a4472c;");
    }
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
    // the tool's browser is up: checked on the process, the progress line shows a human status, not the command
    await expect
      .poll(() => leftovers(l).some((r) => r.includes("--remote-debugging-pipe")), {
        timeout: 120_000,
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
    // every rung of the ladder dies. A long ladder runs out of the turn's stages first («Сделал часть
    // работы» → «Продолжить»); the ladder narrowed to the gateway's models (qwen → opus) is spent at once.
    const paused = page.getByTestId("design-paused");
    const stuck = page.getByTestId("design-stuck");
    await expect(paused.or(stuck)).toBeVisible({ timeout: 120_000 });
    if (await paused.isVisible()) await page.getByTestId("design-continue").click();
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
