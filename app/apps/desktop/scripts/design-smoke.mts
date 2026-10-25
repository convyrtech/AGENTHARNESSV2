/**
 * Design toolchain smoke, run on windows-latest by .github/workflows/design-windows.yml
 * (and locally on Linux). Proves the «Дизайн» tab's Python side without the private
 * design-pipeline:
 *
 *   1. the Python the app ships (python-build-standalone from runtimes/versions.json);
 *   2. the app's own first-use setup (setupDesignTools: venv + pinned wheels + browser
 *      probe; Edge via channel=msedge on Windows), timed, venv size measured;
 *   3. Edge renders playbooks/site/motion/demo?brand=prsloy&t=0.5 → screenshot;
 *   4. check.py on a tiny sample site (PASS) and on one with a raster image (FAIL);
 *   5. run.py init + status + say in a folder with spaces and Cyrillic, against a stub
 *      pipeline (e2e/design/stub-pipeline) and a stub pi, no network.
 *
 * Every path that matters lives under --work, which the workflow sets to a folder like
 * `…\Иван Петров\…`. Writes <out>/design-smoke.json and <out>/demo-prsloy.png.
 *
 *   node --experimental-strip-types scripts/design-smoke.mts --out <dir> --work <dir> [--python <exe>]
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pythonDistMeta } from "./fetch-runtimes.mjs";
import { buildHarnessEnv, python3Shims, venvBinDir, venvPython } from "../src/main/design/env.ts";
import { importPipeline, NOT_TOOLS } from "../src/main/design/pipeline-import.ts";
import { DESIGN_PACKAGES, setupDesignTools } from "../src/main/design/setup.ts";
import { zipDirectory, zipFiles } from "../src/main/design/zip.ts";
import { restrictToCurrentUser } from "../src/main/prsloy/file-acl.ts";

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(DESKTOP, "..", "..", "..");
const HARNESS = join(REPO, "playbooks", "site", "harness");
const STUBS = join(DESKTOP, "e2e", "design");
const WIN = process.platform === "win32";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const out = resolve(arg("--out") ?? "design-smoke-out");
const work = resolve(arg("--work") ?? join(out, "Иван Петров"));
mkdirSync(out, { recursive: true });
mkdirSync(work, { recursive: true });
const report: Record<string, unknown> = { platform: `${process.platform}-${process.arch}` };
const failures: string[] = [];

function check(ok: boolean, what: string): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
}

function dirBytes(dir: string): number {
  let total = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    // lstat: a Linux venv links lib64 → lib, which must not count twice
    const st = lstatSync(p, { throwIfNoEntry: false });
    if (!st || st.isSymbolicLink()) continue;
    total += st.isDirectory() ? dirBytes(p) : st.size;
  }
  return total;
}

function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const t0 = Date.now();
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 600_000,
  });
  return {
    code: r.status,
    out: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? String(r.error) : ""}`,
    seconds: (Date.now() - t0) / 1000,
  };
}

/** The python-build-standalone build the installer ships, or --python. */
async function obtainPython(): Promise<string> {
  const given = arg("--python");
  if (given) return given;
  const versions = JSON.parse(readFileSync(join(DESKTOP, "runtimes", "versions.json"), "utf8"));
  const meta = pythonDistMeta({ os: process.platform, arch: process.arch }, versions);
  const dir = join(out, "python-dist");
  mkdirSync(dir, { recursive: true });
  const archive = join(dir, meta.archiveName);
  const t0 = Date.now();
  const res = await fetch(meta.url);
  if (!res.ok || !res.body) throw new Error(`download ${meta.url}: ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(archive));
  const r = run("tar", ["-xzf", archive, "-C", dir]);
  if (r.code !== 0) throw new Error(`tar: ${r.out}`);
  report.pythonArchiveMB = Math.round(statSync(archive).size / 1e5) / 10;
  report.pythonFetchSeconds = (Date.now() - t0) / 1000;
  return WIN ? join(dir, "python", "python.exe") : join(dir, "python", "bin", "python3");
}

// ---------- 1–2: python + the app's first-use setup ----------
const basePython = await obtainPython();
report.basePython = basePython;
report.basePythonVersion = run(basePython, ["--version"]).out.trim();
const designRoot = join(work, "AppData", "Roaming", "PRSLOY", "design");
const venv = join(designRoot, "venv");
const channel = WIN ? "msedge" : process.env.DP_BROWSER_CHANNEL || undefined;
const phases: Record<string, number> = {};
const t0 = Date.now();
let lastPhase = "";
let lastAt = t0;
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
const setup = await setupDesignTools({
  designRoot,
  venv,
  basePython,
  env,
  ...(channel ? { browserChannel: channel } : {}),
  onProgress: (p) => {
    if (p.phase === lastPhase) return;
    const now = Date.now();
    if (lastPhase) phases[lastPhase] = (now - lastAt) / 1000;
    console.log(`setup: ${p.phase}${p.error ? ` — ${p.error}` : ""}`);
    lastPhase = p.phase;
    lastAt = now;
  },
});
report.setup = {
  result: setup.phase,
  ...(setup.error ? { error: setup.error } : {}),
  seconds: (Date.now() - t0) / 1000,
  phases,
  packages: DESIGN_PACKAGES,
  venvMB: existsSync(venv) ? Math.round(dirBytes(venv) / 1e5) / 10 : 0,
  browserChannel: channel ?? "playwright-chromium",
};
check(setup.phase === "done", `first-use setup (${JSON.stringify(report.setup)})`);
const py = venvPython(venv);

// ---------- 3: Edge renders the motion demo ----------
const demo = join(REPO, "playbooks", "site", "motion", "demo", "index.html");
const shot = join(out, "demo-prsloy.png");
const render = run(
  py,
  [
    "-I",
    "-c",
    [
      "import os, sys",
      "from playwright.sync_api import sync_playwright",
      "from PIL import Image, ImageStat",
      "ch = os.environ.get('DP_BROWSER_CHANNEL')",
      "with sync_playwright() as p:",
      "    b = p.chromium.launch(**({'channel': ch} if ch else {}))",
      "    pg = b.new_page(viewport={'width': 1280, 'height': 800})",
      "    pg.goto(sys.argv[1], wait_until='load')",
      "    pg.wait_for_timeout(1500)",
      "    pg.screenshot(path=sys.argv[2], full_page=False)",
      "    print('browser', b.version)",
      "    b.close()",
      "st = ImageStat.Stat(Image.open(sys.argv[2]).convert('L'))",
      "print('stddev', round(st.stddev[0], 1))",
    ].join("\n"),
    `${pathToFileURL(demo).href}?brand=prsloy&t=0.5`,
    shot,
  ],
  { env: { ...env, ...(channel ? { DP_BROWSER_CHANNEL: channel } : {}) } },
);
const stddev = Number(/stddev ([\d.]+)/.exec(render.out)?.[1] ?? 0);
report.demo = {
  seconds: render.seconds,
  browser: /browser (\S+)/.exec(render.out)?.[1],
  pixelStddev: stddev,
  png: existsSync(shot) ? shot : null,
};
check(
  render.code === 0 && stddev > 5,
  `Edge renders the motion demo (${render.out.trim().slice(-300)})`,
);

// ---------- 4: check.py on a tiny site ----------
const sample = join(work, "Documents", "PRSLOY", "пример сайта");
const site = join(sample, "site");
const page = join(sample, "design", "landing");
mkdirSync(join(site, "landing"), { recursive: true });
mkdirSync(page, { recursive: true });
writeFileSync(
  join(site, "landing", "index.html"),
  '<!doctype html><meta charset="utf-8"><h1 data-signature="drift">Зерно</h1><p>Обжариваем сами.</p>',
);
writeFileSync(
  join(page, "04-motion.md"),
  "# Движение\n\n## Фирменный приём\nКадр f05 эталона: заголовок дрейфует вслед за курсором.\n",
);
const checkPy = (dirSite: string) => run(py, ["-I", join(HARNESS, "check.py"), dirSite, page]);
const pass = checkPy(site);
check(
  pass.code === 0 && pass.out.includes("PASS"),
  `check.py passes a clean site (${pass.out.trim()})`,
);
copyFileSync(join(STUBS, "fixtures", "logo.png"), join(site, "landing", "shot.png"));
const fail = checkPy(site);
check(
  fail.code === 1 && fail.out.includes("растровая картинка"),
  `check.py fails a site with a raster image (${fail.out.trim().slice(0, 200)})`,
);
report.checkPy = { pass: pass.code, fail: fail.code };

// ---------- 5: run.py in a folder with spaces and Cyrillic, no network ----------
const ws = join(work, "Documents", "PRSLOY", "сайт");
// public builds ship no pipeline: the owner adds GitHub's «Download ZIP» of it («У меня есть файл
// инструментов»), main imports it into userData/design/design-pipeline — same code as the app
const pipelineCopy = join(designRoot, "design-pipeline");
mkdirSync(join(work, "Загрузки"), { recursive: true });
const toolsZip = join(work, "Загрузки", "design-pipeline-main.zip");
writeFileSync(toolsZip, zipDirectory(join(STUBS, "stub-pipeline"), "design-pipeline-main"));
const imported = importPipeline(toolsZip, pipelineCopy);
check(
  imported.ok && existsSync(join(pipelineCopy, "tools", "flow.py")),
  `tools zip imported into «${pipelineCopy}» (${JSON.stringify(imported)})`,
);
const slip = join(work, "Загрузки", "slip.zip");
writeFileSync(
  slip,
  zipFiles(
    ["tools/flow.py", "AGENTS.md", "PIPELINE.md", "../../outside.txt"].map((name) => ({
      name: `p/${name}`,
      data: Buffer.from("x"),
    })),
  ),
);
const refused = [
  importPipeline(slip, pipelineCopy),
  importPipeline(join(STUBS, "fixtures"), pipelineCopy),
];
check(
  !refused[0]!.ok &&
    refused[1]!.ok === false &&
    refused[1]!.error === NOT_TOOLS &&
    !existsSync(join(work, "outside.txt")) &&
    existsSync(join(pipelineCopy, "tools", "flow.py")),
  `zip-slip and a non-tools folder refused, the copy stays (${JSON.stringify(refused)})`,
);
report.toolsImport = { ok: imported.ok, refused: refused.map((x) => (x.ok ? "ok" : x.error)) };
// the app ships the pipeline already patched; the stub has nothing to patch
const patch = readFileSync(join(HARNESS, "pipeline-fixes.patch"));
writeFileSync(
  join(pipelineCopy, ".pipeline-fixes.sha256"),
  createHash("sha256").update(patch).digest("hex"),
);
const piHome = join(designRoot, "pi-agent");
mkdirSync(piHome, { recursive: true });
writeFileSync(
  join(piHome, "stub-script.json"),
  JSON.stringify([
    {
      turns: [
        {
          tools: [
            ["bash", { command: "python3 -I design-pipeline/tools/flow.py --page design/landing" }],
          ],
        },
        { text: "ВЛАДЕЛЬЦУ:\nПришлите, что есть: логотип, скрины, ссылку на сайт." },
      ],
    },
  ]),
);
// harness state where the app keeps it: userData/design-state/<workspace id>, user-only (service.ts)
const stateDir = join(
  work,
  "AppData",
  "Roaming",
  "PRSLOY",
  "design-state",
  createHash("sha256").update(resolve(ws)).digest("hex").slice(0, 16),
);
mkdirSync(stateDir, { recursive: true });
const acl = restrictToCurrentUser(stateDir, { isDir: true });
const harnessEnv = {
  ...env,
  HARNESS_STATE_DIR: stateDir,
  PI_BIN: JSON.stringify([py, join(STUBS, "stub_pi.py")]),
  PI_CODING_AGENT_DIR: piHome,
  // nothing listens there: the second opinion must degrade, not crash
  HARNESS_PROXY: "http://127.0.0.1:9",
  PYTHONUTF8: "1",
  DP_CHROMIUM_ONLY: "1",
};
const runPy = join(HARNESS, "run.py");
const init = run(
  py,
  ["-X", "utf8", runPy, "init", ws, "--page", "landing", "--pipeline", pipelineCopy],
  {
    env: harnessEnv,
  },
);
check(
  init.code === 0 && existsSync(join(ws, "design", "landing", "STATUS.md")),
  `run.py init in «${ws}» (${init.out.trim().slice(-300)})`,
);
const status = run(py, ["-X", "utf8", runPy, "status", ws], { env: harnessEnv });
let statusJson: Record<string, unknown> = {};
try {
  statusJson = JSON.parse(status.out.trim().split("\n").at(-1) ?? "{}");
} catch {
  // reported below
}
check(
  status.code === 0 && statusJson.page === "landing" && statusJson.next === "0",
  `run.py status (${status.out.trim().slice(-300)})`,
);
const say = run(py, ["-X", "utf8", runPy, "say", ws, "сделай лендинг для кофейни"], {
  cwd: ws,
  env: harnessEnv,
});
const events = say.out
  .split("\n")
  .map((l) => {
    try {
      return JSON.parse(l) as { ev?: string };
    } catch {
      return {};
    }
  })
  .map((e) => e.ev)
  .filter(Boolean);
check(
  say.code === 0 && events.includes("stage") && events.at(-1) === "owner",
  `run.py say: ${events.join(", ")} (${say.code !== 0 ? say.out.slice(-400) : "ok"})`,
);
// the state folder is the owner's alone: icacls on Windows, 0700 elsewhere
let aclText = "";
if (process.platform === "win32") {
  aclText = run("icacls", [stateDir]).out;
  check(
    acl.ok &&
      existsSync(join(stateDir, "state.json")) &&
      !/Everyone|BUILTIN\\Users|Authenticated Users|NT AUTHORITY\\SYSTEM/i.test(aclText) &&
      /\(F\)/.test(aclText),
    `harness state «${stateDir}» is user-only (${aclText.trim().replace(/\s+/g, " ").slice(0, 300)})`,
  );
} else {
  const mode = statSync(stateDir).mode & 0o777;
  check(
    acl.ok && existsSync(join(stateDir, "state.json")) && mode === 0o700,
    `harness state «${stateDir}» is user-only (mode ${mode.toString(8)})`,
  );
}

// ---------- 5b: the agent's shell (Git Bash on Windows) finds the app's python3, not the Store stub ----------
const shimDir = join(designRoot, "bin");
mkdirSync(shimDir, { recursive: true });
for (const shim of python3Shims(py)) {
  writeFileSync(join(shimDir, shim.name), shim.body, shim.mode ? { mode: shim.mode } : {});
}
const agentEnv = buildHarnessEnv({
  base: env,
  platform: process.platform,
  pathDirs: [shimDir, venvBinDir(venv)],
  piBin: [],
  piAgentDir: piHome,
  proxyUrl: "",
  chromiumOnly: true,
});
const gitBash = join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe");
const shell = process.platform === "win32" ? gitBash : "bash";
rmSync(join(site, "landing", "shot.png"), { force: true });
const probe = run(
  shell,
  [
    "-c",
    'command -v python3; python3 -c "import threading, sqlite3, ssl, sys; print(1, sys.executable)"; ' +
      `python3 -I "${join(HARNESS, "check.py").replaceAll("\\", "/")}" "${site.replaceAll("\\", "/")}" "${page.replaceAll("\\", "/")}"`,
  ],
  { env: agentEnv },
);
const [whichPy = "", stdlib = ""] = probe.out.trim().split(/\r?\n/);
const storeStub = process.env.LOCALAPPDATA
  ? join(process.env.LOCALAPPDATA, "Microsoft", "WindowsApps", "python3.exe")
  : "";
check(
  probe.code === 0 &&
    whichPy.endsWith("PRSLOY/design/bin/python3") &&
    stdlib.startsWith("1 ") &&
    !/WindowsApps/i.test(stdlib) &&
    probe.out.includes("харнесс: PASS"),
  `agent shell: python3 → app shim, full stdlib, check.py PASS (${probe.out.trim().replace(/\s+/g, " ").slice(0, 300)})`,
);
report.agentShell = {
  shell,
  python3: whichPy,
  interpreter: stdlib.slice(2),
  storeStubOnMachine: storeStub ? existsSync(storeStub) : false,
};

report.runPy = {
  ws,
  stateDir,
  acl: aclText.trim() || undefined,
  init: init.seconds,
  status: statusJson,
  sayEvents: events,
  saySeconds: say.seconds,
};

// ---------- 6: step 1 — moves.py packs on the owner's machine (Edge + imageio-ffmpeg) ----------
const cands = join(ws, "design", "landing", "01-cands");
mkdirSync(cands, { recursive: true });
writeFileSync(
  join(cands, "words.json"),
  JSON.stringify({
    num: "180 ₽",
    step1: "Закажите",
    limit: "1 240",
    stamp: "ГОТОВО",
    sloganRise: "с утра",
  }),
);
const movesPy = join(ws, "harness", "moves.py");
const movesEnv = { ...harnessEnv, ...(channel ? { DP_BROWSER_CHANNEL: channel } : {}) };
const cand = run(py, ["-I", movesPy, "candidates", "--page", "design/landing"], {
  cwd: ws,
  env: movesEnv,
});
const videos = ["A", "B", "C"].map((k) => join(cands, `${k}.mp4`));
const videoKB = videos.map((v) => (existsSync(v) ? Math.round(statSync(v).size / 1024) : 0));
check(
  cand.code === 0 &&
    existsSync(join(ws, "design", "landing", "01-candidates.png")) &&
    videoKB.every((kb) => kb > 2),
  `moves.py candidates: 3 sheets + 3 mp4 (${cand.code !== 0 ? cand.out.slice(-400) : videoKB.join(", ") + " KB"})`,
);
const pickRes = run(py, ["-I", movesPy, "pick", "--page", "design/landing", "--pack", "A"], {
  cwd: ws,
  env: movesEnv,
});
const frames = join(ws, "design", "landing", "01-frames");
const nFrames = existsSync(frames)
  ? readdirSync(frames).filter((f) => f.endsWith(".png")).length
  : 0;
check(
  pickRes.code === 0 && nFrames >= 12 && existsSync(join(ws, "design", "landing", "01-pack.json")),
  `moves.py pick A: ${nFrames} frames, 01-teardown.md, 01-pack.json (${pickRes.code !== 0 ? pickRes.out.slice(-300) : "ok"})`,
);
if (existsSync(join(ws, "design", "landing", "01-candidates.png"))) {
  copyFileSync(
    join(ws, "design", "landing", "01-candidates.png"),
    join(out, "moves-candidates.png"),
  );
}
report.moves = {
  candidatesSeconds: cand.seconds,
  pickSeconds: pickRes.seconds,
  videoKB,
  frames: nFrames,
};

// ---------- 7: harness unit tests ----------
const unit = run(py, ["-m", "unittest", "discover", "-s", join(HARNESS, "tests")], {
  env: harnessEnv,
});
check(unit.code === 0, `harness unit tests (${unit.out.trim().split("\n").slice(-3).join(" ")})`);
// the summary line says only how many failed: the tracebacks go to the log
if (unit.code !== 0) console.log(unit.out.trim().split("\n").slice(-120).join("\n"));

report.failures = failures;
writeFileSync(join(out, "design-smoke.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
process.exit(failures.length ? 1 : 0);
