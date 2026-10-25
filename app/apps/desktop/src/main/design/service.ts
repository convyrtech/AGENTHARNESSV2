/**
 * «Дизайн» tab in main: runs the design-pipeline harness (`playbooks/site/harness/run.py`)
 * as child processes and relays its JSONL events to the renderer.
 *
 *   a6proxy.py   reliability proxy on a free loopback port; holds the gateway key
 *   run.py init  one workspace per project (`<project>/prsloy-design`)
 *   run.py say   one owner message → stages until the next question; cancellable
 *
 * The harness, motion library, etalon catalogue and a pinned, pre-patched copy of
 * design-pipeline ship as extraResources under `design/` (scripts/fetch-design.mjs).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import {
  app,
  type BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
  protocol,
  shell,
} from "electron";
import type {
  DesignEvent,
  DesignSetupProgress,
  DesignStatus,
  DesignEventMessage,
} from "@zeno/contracts";
import { restrictToCurrentUser } from "../prsloy/file-acl.ts";
import { buildHarnessEnv, buildModelsJson, python3Shims, venvBinDir, venvPython } from "./env.ts";
import { LineSplitter, parseHarnessLine } from "./events.ts";
import {
  DESIGN_PAGE,
  DESIGN_SCHEME,
  harnessStateDir,
  insideRoot,
  mimeFor,
  parseDesignUrl,
  toDesignFile,
  workspaceFor,
  workspaceId,
} from "./paths.ts";
import { findEntry, type PreviewServer, startPreviewServer } from "./preview-server.ts";
import { killTree, killTreeNow, treeSpawnOptions } from "./proc.ts";
import { listFiles, zipDirectory } from "./zip.ts";
import { DESIGN_DISK_MB, DESIGN_SETUP_MB, setupDesignTools, toolsReady } from "./setup.ts";

export type DesignGateway = { baseUrl: string; apiKey: string };

export type DesignServiceDeps = {
  userDataPath: string;
  /** Folder holding playbooks/, experiments/, design-pipeline/, wheels/. */
  bundleRoot: string;
  getWindow(): BrowserWindow | undefined;
  /** PRSLOY gateway from the provider settings; undefined until the owner pasted a key. */
  getGateway(): DesignGateway | undefined;
  /** Python that creates the venv (bundled runtime, else system). */
  basePython(): string;
  /** Node that runs the pi CLI (bundled runtime, else system). */
  nodeExecutable(): string;
  piCliPath(): Promise<string | undefined>;
  /** pi settings for stage sessions (Windows: the bash shellPath core picked). */
  piSettings?: () => Record<string, unknown>;
  /** Folder with rg/fd for pi's grep/find tools, copied into the design pi home. */
  piToolsDir?: string;
  assertTrustedSender(event: IpcMainInvokeEvent): void;
  /** Where workspaces go when no project folder is open. */
  fallbackRoot: string;
};

const EVENTS_FILE = "app-events.jsonl";
const UNAVAILABLE = "Дизайн-инструменты появятся в следующей версии";
const HISTORY_LIMIT = 400;

type Run = { child: ChildProcess; cancelled: boolean };

export class DesignService {
  readonly #deps: DesignServiceDeps;
  readonly #designRoot: string;
  readonly #venv: string;
  readonly #runs = new Map<string, Run>();
  readonly #workspaces = new Map<string, string>();
  readonly #previews = new Map<string, PreviewServer>();
  readonly #picked = new Map<string, string>();
  #proxy: { child: ChildProcess; url: string; upstream: string } | undefined;
  #proxyStarting: Promise<string> | undefined;
  #setup: Promise<DesignSetupProgress> | undefined;

  constructor(deps: DesignServiceDeps) {
    this.#deps = deps;
    this.#designRoot = join(deps.userDataPath, "design");
    this.#venv = process.env.PRSLOY_DESIGN_VENV || join(this.#designRoot, "venv");
  }

  // ---------- paths ----------
  get #harness(): string {
    return join(this.#deps.bundleRoot, "playbooks", "site", "harness");
  }

  workspace(projectPath: string | undefined): string {
    const ws = workspaceFor(projectPath, this.#deps.fallbackRoot);
    this.#workspaces.set(workspaceId(ws), ws);
    return ws;
  }

  #browserChannel(): string | undefined {
    if (process.env.DP_BROWSER_CHANNEL !== undefined)
      return process.env.DP_BROWSER_CHANNEL || undefined;
    return process.platform === "win32" ? "msedge" : undefined;
  }

  #env(proxyUrl: string, piBin: string[], stateDir?: string): Record<string, string> {
    const shimDir = join(this.#designRoot, "bin");
    return buildHarnessEnv({
      base: process.env,
      platform: process.platform,
      pathDirs: [shimDir, venvBinDir(this.#venv), dirname(piBin[0] ?? "")].filter(
        (d) => d && d !== ".",
      ),
      piBin,
      piAgentDir: join(this.#designRoot, "pi-agent"),
      proxyUrl,
      ...(this.#browserChannel() ? { browserChannel: this.#browserChannel() as string } : {}),
      chromiumOnly: process.env.DP_CHROMIUM_ONLY !== "0",
      ...(stateDir ? { stateDir } : {}),
    });
  }

  /** run.py state for `ws`; `create` makes the folder user-only (same ACL as the key file). */
  #state(ws: string, create = false): { dir: string; legacy: boolean } {
    const root = join(this.#deps.userDataPath, "design-state");
    const st = harnessStateDir(ws, root);
    if (create && !existsSync(st.dir)) {
      const fresh = !existsSync(root);
      mkdirSync(st.dir, { recursive: true });
      if (fresh) restrictToUser(root, true);
      if (!st.legacy) restrictToUser(st.dir, true);
    }
    return st;
  }

  #send(channel: string, payload: unknown): void {
    const win = this.#deps.getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }

  // ---------- history ----------
  #history(ws: string): DesignEvent[] {
    const f = join(this.#state(ws).dir, EVENTS_FILE);
    if (!existsSync(f)) return [];
    const out: DesignEvent[] = [];
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as DesignEvent);
      } catch {
        // torn write
      }
    }
    return out.slice(-HISTORY_LIMIT);
  }

  #emit(ws: string, event: DesignEvent): void {
    const stamped = { ...event, t: event.t ?? Math.round(Date.now() / 100) / 10 };
    try {
      appendFileSync(join(this.#state(ws, true).dir, EVENTS_FILE), `${JSON.stringify(stamped)}\n`);
    } catch {
      // the stream still reaches the window
    }
    const msg: DesignEventMessage = { workspace: ws, event: stamped };
    this.#send("prsloy:design:event", msg);
  }

  // ---------- status / setup ----------
  status(projectPath: string | undefined): DesignStatus {
    const ws = this.workspace(projectPath);
    return {
      toolsReady: this.#toolsReady(),
      setupMb: DESIGN_SETUP_MB,
      setupDiskMb: DESIGN_DISK_MB,
      workspace: ws,
      running: this.#runs.has(ws),
      history: this.#history(ws),
      needsKey: !this.#deps.getGateway(),
      available: this.available(),
    };
  }

  /** run.py and a design-pipeline copy are in the bundle. */
  available(): boolean {
    return (
      existsSync(join(this.#harness, "run.py")) &&
      existsSync(join(this.#deps.bundleRoot, "design-pipeline", "tools", "flow.py"))
    );
  }

  #toolsReady(): boolean {
    return process.env.PRSLOY_DESIGN_VENV
      ? existsSync(venvPython(this.#venv))
      : toolsReady(this.#designRoot, this.#venv);
  }

  setup(): Promise<DesignSetupProgress> {
    if (!this.available()) return Promise.resolve({ phase: "error", error: UNAVAILABLE });
    if (this.#toolsReady()) return Promise.resolve({ phase: "done" });
    this.#setup ??= setupDesignTools({
      designRoot: this.#designRoot,
      venv: this.#venv,
      basePython: this.#deps.basePython(),
      wheelsDir: join(this.#deps.bundleRoot, "wheels"),
      env: buildHarnessEnv({
        base: process.env,
        platform: process.platform,
        pathDirs: [],
        piBin: [],
        piAgentDir: "",
        proxyUrl: "",
        chromiumOnly: true,
      }),
      ...(this.#browserChannel() ? { browserChannel: this.#browserChannel() as string } : {}),
      onProgress: (p) => this.#send("prsloy:design:setup", p),
    }).finally(() => {
      this.#setup = undefined;
    });
    return this.#setup;
  }

  // ---------- proxy ----------
  async #ensureProxy(): Promise<string> {
    const gw = this.#deps.getGateway();
    if (!gw) throw new Error("Нужен ключ PRSLOY: вставьте его в настройках.");
    if (this.#proxy && this.#proxy.child.exitCode === null && this.#proxy.upstream === gw.baseUrl) {
      return this.#proxy.url;
    }
    if (this.#proxy) {
      killTree(this.#proxy.child);
      this.#proxy = undefined;
    }
    this.#proxyStarting ??= this.#startProxy(gw).finally(() => {
      this.#proxyStarting = undefined;
    });
    return this.#proxyStarting;
  }

  #startProxy(gw: DesignGateway): Promise<string> {
    const dir = join(this.#designRoot, "proxy");
    mkdirSync(join(this.#designRoot, "logs"), { recursive: true });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Restrict the directory first so the key file is user-only from the moment it exists.
    restrictToCurrentUser(dir, { isDir: true });
    const keyFile = join(dir, `key-${randomUUID()}`);
    writeFileSync(keyFile, gw.apiKey, { mode: 0o600 });
    restrictToUser(keyFile);
    const removeKey = () => rmSync(keyFile, { force: true });
    const child = spawn(
      venvPython(this.#venv),
      [
        "-I",
        join(this.#harness, "a6proxy.py"),
        "--port",
        "0",
        "--key-file",
        keyFile,
        "--upstream",
        gw.baseUrl,
        "--log",
        join(this.#designRoot, "logs", "a6proxy.jsonl"),
      ],
      { env: this.#env("", []), stdio: ["ignore", "pipe", "pipe"], ...treeSpawnOptions() },
    );
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        removeKey();
        killTree(child);
        reject(new Error("Прокси не запустился за 20 секунд"));
      }, 20_000);
      let err = "";
      child.stderr?.on("data", (b: Buffer) => {
        err = (err + b.toString("utf8")).slice(-600);
      });
      const lines = new LineSplitter();
      child.stdout?.on("data", (b: Buffer) => {
        for (const line of lines.push(b.toString("utf8"))) {
          const m = /a6proxy on 127\.0\.0\.1:(\d+)/.exec(line);
          if (!m) continue;
          clearTimeout(timer);
          // a6proxy reads the key at start; it never stays on disk longer than that.
          removeKey();
          const url = `http://127.0.0.1:${m[1]}`;
          this.#proxy = { child, url, upstream: gw.baseUrl };
          resolve(url);
        }
      });
      child.on("exit", () => {
        clearTimeout(timer);
        removeKey();
        if (this.#proxy?.child === child) this.#proxy = undefined;
        reject(new Error(`Прокси остановился: ${err.trim().slice(-300)}`));
      });
    });
  }

  // ---------- pi ----------
  async #piBin(): Promise<string[]> {
    if (process.env.PRSLOY_DESIGN_PI_BIN) {
      const raw = process.env.PRSLOY_DESIGN_PI_BIN;
      return raw.startsWith("[") ? (JSON.parse(raw) as string[]) : [raw];
    }
    const cli = await this.#deps.piCliPath();
    if (!cli) throw new Error("Не нашёл агента pi в комплекте приложения");
    return [this.#deps.nodeExecutable(), cli];
  }

  #writePiConfig(proxyUrl: string): void {
    const agentDir = join(this.#designRoot, "pi-agent");
    mkdirSync(agentDir, { recursive: true });
    const stages = JSON.parse(readFileSync(join(this.#harness, "stages.json"), "utf8")) as {
      ladder?: unknown;
    };
    writeFileSync(
      join(agentDir, "models.json"),
      JSON.stringify(buildModelsJson(stages, proxyUrl), null, 1),
    );
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify(this.#deps.piSettings?.() ?? {}, null, 1),
    );
    const tools = this.#deps.piToolsDir;
    if (tools && existsSync(tools)) {
      mkdirSync(join(agentDir, "bin"), { recursive: true });
      for (const name of readdirSync(tools).filter((n) => /^(rg|fd)(\.exe)?$/.test(n))) {
        if (!existsSync(join(agentDir, "bin", name))) {
          copyFileSync(join(tools, name), join(agentDir, "bin", name));
          chmodSync(join(agentDir, "bin", name), 0o755);
        }
      }
    }
    const binDir = join(this.#designRoot, "bin");
    mkdirSync(binDir, { recursive: true });
    for (const shim of python3Shims(venvPython(this.#venv))) {
      writeFileSync(join(binDir, shim.name), shim.body, shim.mode ? { mode: shim.mode } : {});
    }
  }

  // ---------- harness ----------
  #python(args: string[], ws: string, env: Record<string, string>): ChildProcess {
    return spawn(venvPython(this.#venv), ["-X", "utf8", ...args], {
      cwd: ws,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      ...treeSpawnOptions(),
    });
  }

  async #ensureWorkspace(ws: string, env: Record<string, string>): Promise<void> {
    if (existsSync(join(this.#state(ws).dir, "state.json"))) return;
    mkdirSync(ws, { recursive: true });
    const pipeline = join(this.#deps.bundleRoot, "design-pipeline");
    const child = this.#python(
      [join(this.#harness, "run.py"), "init", ws, "--page", DESIGN_PAGE, "--pipeline", pipeline],
      dirname(ws),
      env,
    );
    let err = "";
    child.stderr?.on("data", (b: Buffer) => {
      err = (err + b.toString("utf8")).slice(-800);
    });
    const code = await new Promise<number | null>((done) => child.on("close", done));
    if (code !== 0)
      throw new Error(`Не получилось завести папку дизайна: ${err.trim().slice(-300)}`);
  }

  async say(
    projectPath: string | undefined,
    text: string,
    fileTokens: string[],
    retry = false,
  ): Promise<void> {
    const ws = this.workspace(projectPath);
    if (!this.available()) throw new Error(UNAVAILABLE);
    if (this.#runs.has(ws)) throw new Error("Уже работаю над прошлым сообщением");
    if (!this.#toolsReady()) throw new Error("Инструменты дизайна ещё не установлены");
    const files = fileTokens
      .map((tok) => this.#picked.get(tok))
      .filter((p): p is string => !!p && existsSync(p));
    const proxyUrl = await this.#ensureProxy();
    this.#writePiConfig(proxyUrl);
    const state = this.#state(ws, true);
    const env = this.#env(proxyUrl, await this.#piBin(), state.legacy ? undefined : state.dir);
    await this.#ensureWorkspace(ws, env);
    for (const tok of fileTokens) this.#picked.delete(tok);

    if (text || files.length) {
      this.#emit(ws, {
        ev: "user",
        text: text.slice(0, 4000),
        files: files.map((f) => basename(f)),
      });
    }
    const args = [join(this.#harness, "run.py"), "say", ws, text];
    if (retry) args.push("--retry");
    if (files.length) args.push("--files", ...files);
    const child = this.#python(args, ws, env);
    const run: Run = { child, cancelled: false };
    this.#runs.set(ws, run);

    const lines = new LineSplitter();
    let terminal = false;
    let errTail = "";
    const onLine = (line: string) => {
      const ev = parseHarnessLine(line, (abs) => toDesignFile(ws, abs));
      if (!ev) return;
      if (ev.ev === "owner" || ev.ev === "done" || ev.ev === "stuck") terminal = true;
      this.#emit(ws, ev);
    };
    child.stdout?.on("data", (b: Buffer) => lines.push(b.toString("utf8")).forEach(onLine));
    child.stderr?.on("data", (b: Buffer) => {
      errTail = (errTail + b.toString("utf8")).slice(-1200);
    });
    child.on("close", (code) => {
      lines.flush().forEach(onLine);
      this.#runs.delete(ws);
      const failed = !run.cancelled && !terminal && code !== 0;
      this.#emit(ws, {
        ev: "exit",
        code,
        cancelled: run.cancelled,
        ...(failed
          ? { error: errTail.trim().split("\n").slice(-4).join("\n") || `код ${code}` }
          : {}),
      });
    });
    child.on("error", (e) => {
      errTail += String(e);
    });
  }

  cancel(projectPath: string | undefined): void {
    const run = this.#runs.get(this.workspace(projectPath));
    if (!run) return;
    run.cancelled = true;
    killTree(run.child);
  }

  async pickFiles(): Promise<{ token: string; name: string }[]> {
    const win = this.#deps.getWindow();
    const opts = {
      properties: ["openFile", "multiSelections"] as ("openFile" | "multiSelections")[],
    };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (res.canceled) return [];
    return res.filePaths.slice(0, 20).map((p) => {
      const token = randomUUID();
      this.#picked.set(token, p);
      return { token, name: basename(p) };
    });
  }

  async preview(projectPath: string | undefined): Promise<{ url: string } | null> {
    const ws = this.workspace(projectPath);
    const site = join(ws, "site");
    const entry = existsSync(site) ? findEntry(site, DESIGN_PAGE) : undefined;
    if (entry === undefined) return null;
    let server = this.#previews.get(ws);
    if (!server) {
      server = await startPreviewServer(site);
      this.#previews.set(ws, server);
    }
    return { url: server.url + entry };
  }

  /** «Скачать архив»: site/ as a zip wherever the owner saves it (Downloads by default). */
  async exportZip(projectPath: string | undefined): Promise<{ path: string } | null> {
    const ws = this.workspace(projectPath);
    const site = join(ws, "site");
    if (!existsSync(site) || listFiles(site).length === 0) return null;
    let downloads = homedir();
    try {
      downloads = app.getPath("downloads");
    } catch {
      // no downloads folder known: home
    }
    const name = `${basename(dirname(ws))}-site.zip`.replace(/[\\/:*?"<>|]+/g, "-");
    const win = this.#deps.getWindow();
    const opts = {
      defaultPath: join(downloads, name),
      filters: [{ name: "ZIP", extensions: ["zip"] }],
    };
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (res.canceled || !res.filePath) return null;
    writeFileSync(res.filePath, zipDirectory(site, "site"));
    return { path: res.filePath };
  }

  async openFolder(projectPath: string | undefined): Promise<void> {
    const ws = this.workspace(projectPath);
    const site = join(ws, "site");
    const target = existsSync(site) ? site : ws;
    mkdirSync(target, { recursive: true });
    await shell.openPath(target);
  }

  // ---------- protocol ----------
  async serveFile(request: Request): Promise<Response> {
    const parsed = parseDesignUrl(request.url);
    const ws = parsed ? this.#workspaces.get(parsed.id) : undefined;
    const target = parsed && ws ? insideRoot(ws, parsed.rel) : undefined;
    if (!target || !existsSync(target) || !statSync(target).isFile()) {
      return new Response("Not found", { status: 404 });
    }
    const size = statSync(target).size;
    const headers: Record<string, string> = {
      "Content-Type": mimeFor(target),
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    };
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "");
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > end || start >= size) {
        return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
      }
      const body = Readable.toWeb(createReadStream(target, { start, end })) as ReadableStream;
      return new Response(body, {
        status: 206,
        headers: {
          ...headers,
          "Content-Range": `bytes ${start}-${end}/${size}`,
          "Content-Length": String(end - start + 1),
        },
      });
    }
    const body = Readable.toWeb(createReadStream(target)) as ReadableStream;
    return new Response(body, {
      status: 200,
      headers: { ...headers, "Content-Length": String(size) },
    });
  }

  /** App quit: nothing the harness started may outlive the window (proxy, pi, browsers). */
  dispose(): void {
    for (const run of this.#runs.values()) {
      run.cancelled = true;
      killTreeNow(run.child);
    }
    if (this.#proxy) killTreeNow(this.#proxy.child);
    for (const s of this.#previews.values()) void s.close();
  }
}

/** User-only ACL (Windows: SID via icacls; POSIX: 0600/0700) on the key file and state folders. */
function restrictToUser(path: string, isDir = false): void {
  const result = restrictToCurrentUser(path, { isDir });
  if (!result.ok) console.warn("[design] could not restrict", path, result.detail);
}

function projectArg(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim() ? raw : undefined;
}

/** Wire IPC + protocol. Call once after app ready. */
export function registerDesignIpc(deps: DesignServiceDeps): DesignService {
  const svc = new DesignService(deps);
  protocol.handle(DESIGN_SCHEME, (request) => svc.serveFile(request));
  const guard =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (event: IpcMainInvokeEvent, ...args: A): R => {
      deps.assertTrustedSender(event);
      return fn(...args);
    };
  ipcMain.handle(
    "prsloy:design:status",
    guard((p: unknown) => svc.status(projectArg(p))),
  );
  ipcMain.handle(
    "prsloy:design:setup",
    guard(() => svc.setup()),
  );
  ipcMain.handle(
    "prsloy:design:say",
    guard((p: unknown, text: unknown, tokens: unknown, retry: unknown) =>
      svc.say(
        projectArg(p),
        typeof text === "string" ? text : "",
        Array.isArray(tokens) ? tokens.filter((x): x is string => typeof x === "string") : [],
        retry === true,
      ),
    ),
  );
  ipcMain.handle(
    "prsloy:design:cancel",
    guard((p: unknown) => svc.cancel(projectArg(p))),
  );
  ipcMain.handle(
    "prsloy:design:pick-files",
    guard(() => svc.pickFiles()),
  );
  ipcMain.handle(
    "prsloy:design:preview",
    guard((p: unknown) => svc.preview(projectArg(p))),
  );
  ipcMain.handle(
    "prsloy:design:open-folder",
    guard((p: unknown) => svc.openFolder(projectArg(p))),
  );
  ipcMain.handle(
    "prsloy:design:export-zip",
    guard((p: unknown) => svc.exportZip(projectArg(p))),
  );
  // index.ts quits through before-quit → app.exit(), which never emits will-quit.
  app.on("before-quit", () => svc.dispose());
  process.once("exit", () => svc.dispose());
  return svc;
}
