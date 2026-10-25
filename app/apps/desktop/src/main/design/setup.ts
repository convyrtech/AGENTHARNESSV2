/**
 * First use of the «Дизайн» tab: a venv from the bundled Python with the pipeline's
 * tools (Pillow, numpy, Playwright), then a browser smoke launch. On Windows the browser
 * is the installed Microsoft Edge (`channel="msedge"`), so nothing else is downloaded.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DesignSetupProgress } from "@zeno/contracts";
import { venvPython } from "./env.ts";

/**
 * Pinned to the versions the pipeline was verified with; bump together with design-lock.json.
 * fonttools: flow.py's brand gate runs font_check.py, which imports it (the pipeline's
 * requirements.txt lists it as test-only). imageio-ffmpeg: ffmpeg for the step-1 pack videos
 * (harness/moves.py); the owner's machine has none.
 */
export const DESIGN_PACKAGES = [
  "pillow==13.0.0",
  "numpy==2.5.4",
  "playwright==1.63.0",
  "fonttools==4.67.0",
  "imageio-ffmpeg==0.6.0",
] as const;
/**
 * Measured on windows-latest (design-windows.yml): win_amd64 cp312 wheels download 90 MB
 * (playwright ≈ 39 with its driver, imageio-ffmpeg ≈ 31, numpy ≈ 13, pillow ≈ 7, fonttools + deps ≈ 3);
 * the venv takes 302 MB on disk; the whole setup ran in 18 s on the runner's network.
 */
export const DESIGN_SETUP_MB = 90;
export const DESIGN_DISK_MB = 300;
const STAMP = "tools.json";

export type ToolsStamp = { packages: string[]; python: string };

export function readToolsStamp(designRoot: string): ToolsStamp | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(designRoot, STAMP), "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return undefined;
    const rec = raw as Record<string, unknown>;
    if (!Array.isArray(rec.packages) || typeof rec.python !== "string") return undefined;
    return { packages: rec.packages.map(String), python: rec.python };
  } catch {
    return undefined;
  }
}

export function toolsReady(designRoot: string, venv: string): boolean {
  const stamp = readToolsStamp(designRoot);
  return (
    !!stamp &&
    stamp.packages.join(" ") === DESIGN_PACKAGES.join(" ") &&
    existsSync(venvPython(venv))
  );
}

/**
 * pip `--progress-bar raw` prints `Progress <done> of <total>` per file. Sum finished
 * files so the bar moves across the whole install, not per wheel.
 */
export class PipProgress {
  #finished = 0;
  #current = 0;
  #currentTotal = 0;

  /** Returns cumulative bytes when the line was a progress line. */
  line(text: string): number | undefined {
    const m = /^Progress (\d+) of (\d+)/.exec(text.trim());
    if (!m) return undefined;
    const done = Number(m[1]);
    const total = Number(m[2]);
    if (total !== this.#currentTotal || done < this.#current) {
      // a new file started
      this.#finished += this.#current;
      this.#currentTotal = total;
    }
    this.#current = done;
    return this.#finished + this.#current;
  }
}

/** Installed Edge on Windows (per-machine or per-user install). */
export function findEdge(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const roots = [env["ProgramFiles(x86)"], env.ProgramFiles, env.LOCALAPPDATA].filter(
    (x): x is string => typeof x === "string" && !!x,
  );
  for (const root of roots) {
    const exe = join(root, "Microsoft", "Edge", "Application", "msedge.exe");
    if (existsSync(exe)) return exe;
  }
  return undefined;
}

export type SetupInput = {
  designRoot: string;
  venv: string;
  /** Bundled (or system) Python used to create the venv. */
  basePython: string;
  /** Bundled wheels folder: install offline when present. */
  wheelsDir?: string;
  env: Record<string, string>;
  browserChannel?: string;
  onProgress: (p: DesignSetupProgress) => void;
  signal?: AbortSignal;
};

function run(
  cmd: string,
  args: string[],
  env: Record<string, string>,
  onLine: (line: string) => void,
  signal?: AbortSignal,
): Promise<{ code: number | null; tail: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, windowsHide: true, ...(signal ? { signal } : {}) });
    const tail: string[] = [];
    const feed = (buf: Buffer) => {
      for (const line of buf.toString("utf8").split(/\r?\n|\r/)) {
        if (!line.trim()) continue;
        onLine(line);
        tail.push(line);
        if (tail.length > 20) tail.shift();
      }
    };
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);
    child.on("error", (e) => resolve({ code: -1, tail: String(e) }));
    child.on("close", (code) => resolve({ code, tail: tail.join("\n") }));
  });
}

const BROWSER_PROBE = [
  "import os, sys",
  "from playwright.sync_api import sync_playwright",
  "ch = os.environ.get('DP_BROWSER_CHANNEL')",
  "with sync_playwright() as p:",
  "    b = p.chromium.launch(**({'channel': ch} if ch else {}))",
  "    pg = b.new_page(); pg.set_content('<p>ok</p>'); print(pg.inner_text('p')); b.close()",
].join("\n");

export async function setupDesignTools(input: SetupInput): Promise<DesignSetupProgress> {
  const { designRoot, venv, env, onProgress } = input;
  const fail = (error: string): DesignSetupProgress => {
    const p: DesignSetupProgress = { phase: "error", error };
    onProgress(p);
    return p;
  };
  mkdirSync(designRoot, { recursive: true });
  if (process.platform === "win32" && input.browserChannel === "msedge" && !findEdge()) {
    return fail("Не нашёл Microsoft Edge. Установите его с microsoft.com/edge и попробуйте снова.");
  }

  onProgress({ phase: "venv" });
  if (!existsSync(venvPython(venv))) {
    rmSync(venv, { recursive: true, force: true });
    const r = await run(input.basePython, ["-m", "venv", venv], env, () => {}, input.signal);
    if (r.code !== 0) return fail(`Не получилось подготовить Python: ${r.tail.slice(-300)}`);
  }

  const py = venvPython(venv);
  const offline =
    input.wheelsDir && existsSync(input.wheelsDir) && readdirSync(input.wheelsDir).length > 0;
  const totalBytes = DESIGN_SETUP_MB * 1024 * 1024;
  onProgress(offline ? { phase: "install" } : { phase: "download", doneBytes: 0, totalBytes });
  const progress = new PipProgress();
  let last = 0;
  const pipArgs = [
    "-m",
    "pip",
    "install",
    "--disable-pip-version-check",
    "--no-input",
    "--only-binary=:all:",
    "--progress-bar",
    "raw",
    ...(offline ? ["--no-index", "--find-links", input.wheelsDir as string] : []),
    ...DESIGN_PACKAGES,
  ];
  const pip = await run(
    py,
    pipArgs,
    env,
    (line) => {
      if (line.startsWith("Installing collected packages")) {
        onProgress({ phase: "install" });
        return;
      }
      const done = progress.line(line);
      if (done !== undefined && !offline && Date.now() - last > 200) {
        last = Date.now();
        onProgress({ phase: "download", doneBytes: Math.min(done, totalBytes), totalBytes });
      }
    },
    input.signal,
  );
  if (pip.code !== 0) {
    return fail(
      /ConnectionError|Max retries|NewConnectionError|timed out/i.test(pip.tail)
        ? "Нет связи с сервером пакетов. Проверьте интернет и попробуйте снова."
        : `Инструменты не установились: ${pip.tail.slice(-300)}`,
    );
  }

  onProgress({ phase: "browser" });
  const probeEnv = {
    ...env,
    ...(input.browserChannel ? { DP_BROWSER_CHANNEL: input.browserChannel } : {}),
  };
  const probe = await run(py, ["-I", "-c", BROWSER_PROBE], probeEnv, () => {}, input.signal);
  if (probe.code !== 0 || !probe.tail.includes("ok")) {
    return fail(`Браузер для проверки страниц не запустился: ${probe.tail.slice(-300)}`);
  }

  const stamp: ToolsStamp = { packages: [...DESIGN_PACKAGES], python: input.basePython };
  writeFileSync(join(designRoot, STAMP), JSON.stringify(stamp, null, 1));
  const done: DesignSetupProgress = { phase: "done" };
  onProgress(done);
  return done;
}
