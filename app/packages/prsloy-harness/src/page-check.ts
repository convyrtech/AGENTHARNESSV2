// Проверка страницы, которую сделал агент, в настоящем браузере (стоп-гейт «Кода»): `index.html` файлом
// (как казуал двойным кликом) и через свой сервер на 127.0.0.1, на 390 и 1440 px. Ошибки консоли и pageerror,
// незагрузившиеся файлы, правила раскладки (горизонтальная прокрутка и т. п.). Браузер — Python-Playwright из venv
// «Дизайна» (Edge на Windows): `PRSLOY_DESIGN_PYTHON`. Нет его — проверка молча пропускается, ничего не ставим.
import { spawn } from "node:child_process";
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join, normalize, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { lintLayout } from "@zeno/layout-rules";
import { sanitizedEnv } from "./options.ts";
import { MODULE_SCRIPT } from "./page-paths.ts";
import {
  keyboardFindings,
  probeAct,
  probeAxe,
  probeFocus,
  probeLinks,
  probeMain,
  probeTargets,
} from "./page-probe.ts";

export const PAGE_VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
] as const;

export interface PageIssue {
  /** «файлом» или «через сервер». */
  target: "file" | "http";
  width: number;
  /**
   * interaction — ошибка после нажатия (research/28 §4 п. 1); link — якорь в никуда или ссылка на свой файл,
   * которого нет; a11y — axe, только serious/critical; keyboard — Tab не доходит или фокус застрял.
   */
  kind:
    | "console"
    | "pageerror"
    | "request"
    | "layout"
    | "interaction"
    | "link"
    | "a11y"
    | "keyboard";
  /** Правило раскладки (root-hscroll, overlap, …) или пусто. */
  rule?: string;
  where: string;
  detail: string;
  /** Коробка элемента (у правил раскладки), CSS px от левого верхнего угла окна. */
  box?: { x: number; y: number; w: number; h: number };
}

export interface PageCheckResult {
  entry: string;
  issues: PageIssue[];
  /** Браузер не запустился / таймаут: проверки не было (не красное). */
  skipped?: string;
  /** Файлом не открывали (Vite, type="module"). */
  fileSkipped?: boolean;
}

const VITE_CONFIGS = [
  "vite.config.js",
  "vite.config.ts",
  "vite.config.mjs",
  "vite.config.mts",
  "vite.config.cjs",
];

/** Какую страницу открывать: у Vite — собранную `dist/index.html`, иначе `index.html` или единственный .html. */
export function findPageEntry(cwd: string): string | undefined {
  if (VITE_CONFIGS.some((f) => existsSync(join(cwd, f)))) {
    for (const d of ["dist", "build", "out"]) {
      const p = join(cwd, d, "index.html");
      if (existsSync(p)) return p;
    }
    return undefined;
  }
  if (existsSync(join(cwd, "index.html"))) return join(cwd, "index.html");
  let html: string[] = [];
  try {
    html = readdirSync(cwd).filter((n) => /\.html?$/i.test(n) && !n.startsWith("."));
  } catch {
    return undefined;
  }
  return html.length === 1 ? join(cwd, html[0]!) : undefined;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

/** Статика папки на 127.0.0.1: без dot-файлов (.env), без выхода за папку. */
export async function serveStatic(
  root: string,
): Promise<{ origin: string; close: () => Promise<void> }> {
  const base = resolve(root);
  const server: Server = createServer((req, res) => {
    let path: string;
    try {
      path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const file = normalize(join(base, path.endsWith("/") ? `${path}index.html` : path));
    const rel = relative(base, file);
    if (rel.startsWith("..") || rel.split(sep).some((p) => p.startsWith("."))) {
      res.writeHead(404).end();
      return;
    }
    let ok = false;
    try {
      ok = statSync(file).isFile();
    } catch {
      ok = false;
    }
    if (!ok) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}

// Сценарий для Python-Playwright: читает задание из stdin, печатает JSON. Передаётся через `-c`, без файла
// (в asar-сборке путь к .py рядом с модулем не открыть).
const PY = String.raw`
import json, sys
from playwright.sync_api import sync_playwright
job = json.load(sys.stdin)
out = []

def interact(page, t, ia, found):
    import time
    start = time.time()
    for l in page.evaluate(ia["links"]):
        found.append({"kind": "link", "where": l["selector"], "detail": l["detail"]})
    try:
        page.add_script_tag(content=ia["axeSource"])
        for v in page.evaluate(ia["axe"]):
            found.append({"kind": "a11y", "rule": v["id"], "where": ", ".join(v["nodes"]), "detail": v["help"]})
    except Exception:
        pass
    main = page.evaluate(ia["main"])
    path = []
    for _ in range(ia["tabs"]):
        page.keyboard.press("Tab")
        path.append(page.evaluate(ia["focus"]))
    found.append({"kind": "keyboard-raw", "path": path, "main": main})
    n = len(page.evaluate(ia["list"], ia["max"]))
    for i in range(n):
        if (time.time() - start) * 1000 > ia["budgetMs"]:
            break
        before = len(found)
        try:
            raw = page.evaluate(ia["act"], {"i": i, "max": ia["max"], "list": ia["list"]})
        except Exception:
            raw = ""
        page.wait_for_timeout(ia["afterMs"])
        target = json.loads(raw) if raw else None
        for f in found[before:]:
            if target and f["kind"] in ("console", "pageerror", "request"):
                f["kind"] = "interaction"
                f["where"] = target["selector"]
                f["detail"] = "после нажатия «" + target["label"] + "»: " + f["detail"]
        if page.url.split("#")[0] != t["url"].split("#")[0]:
            page.goto(t["url"], wait_until="load", timeout=ia["backTimeoutMs"])
            page.wait_for_timeout(job["settleMs"])

with sync_playwright() as p:
    kw = {"channel": job["channel"]} if job.get("channel") else {}
    browser = p.chromium.launch(**kw)
    try:
        for t in job["targets"]:
            for vp in job["viewports"]:
                ctx = browser.new_context(viewport=vp)
                page = ctx.new_page()
                found = []
                page.on("console", lambda m: found.append({"kind": "console", "detail": m.text}) if m.type == "error" else None)
                page.on("pageerror", lambda e: found.append({"kind": "pageerror", "detail": str(e)}))
                page.on("requestfailed", lambda r: found.append({"kind": "request", "detail": r.url + " " + (r.failure or "")}))
                page.on("response", lambda r: found.append({"kind": "request", "detail": r.url + " " + str(r.status)}) if r.status >= 400 and r.url.startswith(job["localOrigin"]) else None)
                try:
                    page.goto(t["url"], wait_until="load", timeout=job["navTimeoutMs"])
                    page.wait_for_timeout(job["settleMs"])
                    page.evaluate(job["freeze"])
                    for v in page.evaluate(job["lint"], job["lintArg"]):
                        found.append({"kind": "layout", "rule": v["rule"], "where": v["selector"] + (" «" + v["text"] + "»" if v.get("text") else ""), "detail": v["detail"], **({"box": v["box"]} if v.get("box") else {})})
                    ia = job.get("interact")
                    if ia and t["name"] == ia["target"] and vp["width"] == ia["width"]:
                        try:
                            interact(page, t, ia, found)
                        except Exception:
                            pass
                except Exception as e:
                    found.append({"kind": "pageerror", "detail": "страница не открылась: " + str(e).splitlines()[0]})
                for f in found:
                    f["target"] = t["name"]
                    f["width"] = vp["width"]
                    out.append(f)
                ctx.close()
    finally:
        browser.close()
print(json.dumps(out, ensure_ascii=False))
`;

export interface NodePage {
  on(event: string, cb: (x: any) => void): void;
  goto(url: string, o: { waitUntil: "load"; timeout: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate(fn: string, arg?: unknown): Promise<unknown>;
  addScriptTag(o: { content: string }): Promise<unknown>;
  keyboard: { press(key: string): Promise<void> };
  url(): string;
}

/** Мини-интерфейс Node-Playwright: тесты и замер (в приложении — Python из venv «Дизайна»). */
export interface NodePlaywright {
  chromium: {
    launch(o?: { executablePath?: string; channel?: string }): Promise<{
      newContext(o: { viewport: { width: number; height: number } }): Promise<{
        newPage(): Promise<NodePage>;
        close(): Promise<void>;
      }>;
      close(): Promise<void>;
    }>;
  };
}

interface Job {
  channel: string | undefined;
  targets: { name: string; url: string }[];
  viewports: readonly { width: number; height: number }[];
  lint: string;
  lintArg: unknown;
  freeze: string;
  navTimeoutMs: number;
  settleMs: number;
  /** Свои адреса (сервер и file://): ответы 4xx/5xx с них — незагрузившийся файл. */
  localOrigin: string;
  /** Нажатия, ссылки, клавиатура, axe — один раз: через сервер, на 1440 px. */
  interact?: Interact;
}

export interface Interact {
  target: "http";
  width: number;
  max: number;
  budgetMs: number;
  afterMs: number;
  /** Возврат на страницу после ухода с неё: короче обычного открытия, чтобы бюджет не перерасходовался. */
  backTimeoutMs: number;
  tabs: number;
  list: string;
  act: string;
  links: string;
  focus: string;
  main: string;
  axe: string;
  axeSource: string;
}

type RawIssue = Omit<PageIssue, "where" | "kind"> & {
  kind: PageIssue["kind"] | "keyboard-raw";
  where?: string;
  path?: string[];
  main?: { label: string; selector: string }[];
};

/** Тот же сценарий, что `interact` в PY. */
async function interactNode(
  page: NodePage,
  url: string,
  ia: Interact,
  job: Job,
  found: Omit<RawIssue, "target" | "width">[],
): Promise<void> {
  const start = Date.now();
  for (const l of (await page.evaluate(`(${ia.links})()`)) as {
    selector: string;
    detail: string;
  }[])
    found.push({ kind: "link", where: l.selector, detail: l.detail });
  try {
    await page.addScriptTag({ content: ia.axeSource });
    for (const v of (await page.evaluate(`(${ia.axe})()`)) as {
      id: string;
      nodes: string[];
      help: string;
    }[])
      found.push({ kind: "a11y", rule: v.id, where: v.nodes.join(", "), detail: v.help });
  } catch {
    // axe не встал — без него
  }
  const main = (await page.evaluate(`(${ia.main})()`)) as { label: string; selector: string }[];
  const path: string[] = [];
  for (let k = 0; k < ia.tabs; k++) {
    await page.keyboard.press("Tab");
    path.push((await page.evaluate(`(${ia.focus})()`)) as string);
  }
  found.push({ kind: "keyboard-raw", detail: "", path, main });
  const n = ((await page.evaluate(`(${ia.list})(${ia.max})`)) as unknown[]).length;
  for (let i = 0; i < n; i++) {
    if (Date.now() - start > ia.budgetMs) break;
    const before = found.length;
    let raw = "";
    try {
      raw = (await page.evaluate(
        `(${ia.act})(${JSON.stringify({ i, max: ia.max, list: ia.list })})`,
      )) as string;
    } catch {
      raw = "";
    }
    await page.waitForTimeout(ia.afterMs);
    const target = raw ? (JSON.parse(raw) as { label: string; selector: string }) : undefined;
    for (const f of found.slice(before))
      if (target && (f.kind === "console" || f.kind === "pageerror" || f.kind === "request")) {
        f.kind = "interaction";
        f.where = target.selector;
        f.detail = `после нажатия «${target.label}»: ${f.detail}`;
      }
    if (page.url().split("#")[0] !== url.split("#")[0]) {
      await page.goto(url, { waitUntil: "load", timeout: ia.backTimeoutMs });
      await page.waitForTimeout(job.settleMs);
    }
  }
}

/** Тот же сценарий, что PY, на Node-Playwright. */
async function runNode(pw: NodePlaywright, job: Job, executablePath?: string): Promise<RawIssue[]> {
  const browser = await pw.chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    ...(job.channel ? { channel: job.channel } : {}),
  });
  const out: RawIssue[] = [];
  try {
    for (const t of job.targets)
      for (const vp of job.viewports) {
        const ctx = await browser.newContext({ viewport: { ...vp } });
        const page = await ctx.newPage();
        const found: Omit<RawIssue, "target" | "width">[] = [];
        page.on("console", (m: { type(): string; text(): string }) => {
          if (m.type() === "error") found.push({ kind: "console", detail: m.text() });
        });
        page.on("pageerror", (e: Error) =>
          found.push({ kind: "pageerror", detail: String(e.message ?? e) }),
        );
        page.on("requestfailed", (r: { url(): string; failure(): { errorText: string } | null }) =>
          found.push({ kind: "request", detail: `${r.url()} ${r.failure()?.errorText ?? ""}` }),
        );
        page.on("response", (r: { url(): string; status(): number }) => {
          if (r.status() >= 400 && r.url().startsWith(job.localOrigin))
            found.push({ kind: "request", detail: `${r.url()} ${r.status()}` });
        });
        try {
          await page.goto(t.url, { waitUntil: "load", timeout: job.navTimeoutMs });
          await page.waitForTimeout(job.settleMs);
          await page.evaluate(job.freeze);
          const lint = (await page.evaluate(`(${job.lint})(${JSON.stringify(job.lintArg)})`)) as {
            rule: string;
            selector: string;
            text?: string;
            detail: string;
            box?: PageIssue["box"];
          }[];
          for (const v of lint)
            found.push({
              kind: "layout",
              rule: v.rule,
              where: v.selector + (v.text ? ` «${v.text}»` : ""),
              detail: v.detail,
              ...(v.box ? { box: v.box } : {}),
            });
          const ia = job.interact;
          if (ia && t.name === ia.target && vp.width === ia.width)
            await interactNode(page, t.url, ia, job, found).catch(() => undefined);
        } catch (e) {
          found.push({
            kind: "pageerror",
            detail: `страница не открылась: ${String((e as Error).message).split("\n")[0]}`,
          });
        }
        for (const f of found)
          out.push({ ...f, target: t.name as PageIssue["target"], width: vp.width });
        await ctx.close();
      }
  } finally {
    await browser.close();
  }
  return out;
}

/** Анимации и переходы в ноль перед правилами: элемент посреди анимации даёт ложные срабатывания (так же у ci). */
const FREEZE = `() => { const s = document.createElement("style"); s.textContent = "*, *::before, *::after { transition: none !important; animation: none !important; }"; document.head.appendChild(s); }`;

/** Правила-подсказки: сами по себе к работе не возвращают, идут в конце списка. */
export const HINT_RULES = new Set(["target-size", "small-text"]);
/** Для страницы пользователя не смотрим: минимальное окно и фокус — правила окна приложения. */
const IGNORED_RULES = new Set(["window-min", "focus-hidden"]);

export interface PageCheckOptions {
  /** Python с Playwright (venv «Дизайна»). Без него — пропуск. */
  python?: string | undefined;
  /** Вместо Python — Node-Playwright (тесты, замер) и, если нужно, путь к Chromium. */
  playwright?: NodePlaywright | undefined;
  executablePath?: string | undefined;
  /** Канал Chromium: msedge на Windows (как «Дизайн»). */
  channel?: string | undefined;
  /** Исходник функции правил раскладки (по умолчанию `lintLayout` из `@zeno/layout-rules`). */
  lint?: string;
  /** Нажатия, ссылки, клавиатура и axe (research/28 §4). По умолчанию включены; false — только открыть. */
  interact?: boolean;
  timeoutMs?: number;
}

/**
 * Сколько нажимать и сколько ждать: ≤15 действий и ≤10 с на всё (бюджет — на ходу, не обрезаем посередине).
 * Замер (STATUS): +0,3–1,3 с на страницах бенча, +10 с на тяжёлой (20 уходящих кнопок, 30 ссылок, 5 форм). Худший
 * случай — бюджет плюс одно действие с возвратом ≤3 с, около 14 с.
 */
export const INTERACT_LIMITS = {
  width: 1440,
  max: 15,
  budgetMs: 10_000,
  afterMs: 300,
  backTimeoutMs: 3_000,
  tabs: 30,
} as const;

/** Метка запросов probeLinks (сервер смотрит только путь). */
const LINK_PROBE = "prsloy-link-check";

let axeSource: string | undefined;
async function interactJob(): Promise<Interact> {
  // axe-core (MPL-2.0) — как есть, исходником в страницу; 1,3 МБ читаем один раз и только когда нужно.
  axeSource ??= ((await import("axe-core")) as unknown as { default: { source: string } }).default
    .source;
  return {
    target: "http",
    ...INTERACT_LIMITS,
    list: probeTargets.toString(),
    act: probeAct.toString(),
    links: probeLinks.toString(),
    focus: probeFocus.toString(),
    main: probeMain.toString(),
    axe: probeAxe.toString(),
    axeSource,
  };
}

export function designPython(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const p = env.PRSLOY_DESIGN_PYTHON;
  return p && existsSync(p) ? p : undefined;
}

function runPython(
  python: string,
  job: unknown,
  timeoutMs: number,
): Promise<{ out: string; err?: string }> {
  return new Promise((done) => {
    const env: NodeJS.ProcessEnv = { ...sanitizedEnv(), PYTHONIOENCODING: "utf-8" };
    if (process.env.PLAYWRIGHT_BROWSERS_PATH)
      env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH;
    const child = spawn(python, ["-I", "-c", PY], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ out: "", err: "таймаут" });
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => {
      if (err.length < 4000) err += d.toString("utf8");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      done({ out: "", err: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done(
        code === 0
          ? { out }
          : { out: "", err: err.trim().split("\n").slice(-1)[0] ?? `код ${code}` },
      );
    });
    child.stdin.end(JSON.stringify(job));
  });
}

/**
 * Открывается ли страница двойным кликом в принципе. Vite и любые `type="module"` — нет (CORS у file://):
 * для них только сервер, совета про двойной клик не даём (решение дирижёра, вариант «а»).
 */
export function fileOpens(cwd: string, entry: string): boolean {
  if (VITE_CONFIGS.some((f) => existsSync(join(cwd, f)))) return false;
  try {
    return !MODULE_SCRIPT.test(readFileSync(entry, "utf8"));
  } catch {
    return false;
  }
}

/** Открыть страницу файлом и через сервер на двух ширинах. undefined — проверять нечем (нет браузера или страницы). */
export async function checkPage(
  cwd: string,
  options: PageCheckOptions = {},
): Promise<PageCheckResult | undefined> {
  const python = options.playwright ? undefined : (options.python ?? designPython());
  if (!python && !options.playwright) return undefined;
  const entry = findPageEntry(cwd);
  if (!entry) return undefined;
  const root = resolve(entry, "..");
  const server = await serveStatic(root);
  try {
    const job: Job = {
      channel: options.channel ?? (process.platform === "win32" ? "msedge" : undefined),
      targets: [
        ...(fileOpens(cwd, entry) ? [{ name: "file", url: pathToFileURL(entry).href }] : []),
        { name: "http", url: `${server.origin}/${relative(root, entry).replace(/\\/g, "/")}` },
      ],
      viewports: PAGE_VIEWPORTS,
      // Правила раскладки — общий модуль с ci (layout-lint приложения): функция уходит в страницу исходником.
      lint: options.lint ?? lintLayout.toString(),
      // Для lintLayout ci: окно чужой страницы без минимума, фокус не трогаем (он меняет состояние страницы).
      lintArg: { minWidth: 0, minHeight: 0, checkFocus: false, scrollsY: true },
      freeze: FREEZE,
      navTimeoutMs: 8_000,
      settleMs: 300,
      localOrigin: server.origin,
      ...(options.interact === false ? {} : { interact: await interactJob() }),
    };
    const rel = relative(cwd, entry).replace(/\\/g, "/");
    let raw: RawIssue[];
    if (options.playwright) {
      try {
        raw = await runNode(options.playwright, job, options.executablePath);
      } catch (e) {
        return {
          entry: rel,
          issues: [],
          skipped: String((e as Error).message).split("\n")[0] ?? "браузер не запустился",
        };
      }
    } else {
      const { out, err } = await runPython(python!, job, options.timeoutMs ?? 45_000);
      if (err !== undefined) return { entry: rel, issues: [], skipped: err };
      try {
        raw = JSON.parse(out) as RawIssue[];
      } catch {
        return { entry: rel, issues: [], skipped: "непонятный ответ браузера" };
      }
    }
    // Адрес сервера и папка — в относительный путь: тогда «файлом» и «через сервер» сливаются в одну строку.
    const fileRoot = pathToFileURL(root).href;
    const local = (t: string) =>
      t
        .split(`${server.origin}/`)
        .join("./")
        .split(`${fileRoot}/`)
        .join("./")
        .split("file:///")
        .join("/");
    const issues = raw
      // «Failed to load resource» в консоли дублирует незагрузившийся запрос (там виден файл).
      .filter((i) => !(i.kind === "console" && /^Failed to load resource\b/.test(i.detail)))
      // Свои запросы проверки ссылок — не ошибки страницы: их 404 уже в находке «ссылка … ведёт на …».
      .filter((i) => !(i.kind === "request" && i.detail.includes(LINK_PROBE)))
      .filter((i) => !(i.kind === "layout" && i.rule && IGNORED_RULES.has(i.rule)))
      .flatMap((i): PageIssue[] => {
        if (i.kind !== "keyboard-raw") {
          const { path: _p, main: _m, ...rest } = i;
          return [{ ...rest, kind: i.kind, where: i.where ?? "", detail: local(i.detail) }];
        }
        return keyboardFindings(i.path ?? [], i.main ?? []).map((k) => ({
          target: i.target,
          width: i.width,
          kind: "keyboard",
          rule: k.kind,
          where: k.selector,
          detail: k.detail,
        }));
      });
    return { entry: rel, issues, ...(job.targets.length === 1 ? { fileSkipped: true } : {}) };
  } finally {
    await server.close();
  }
}

/**
 * Подсказка — сама по себе к работе не возвращает: мелкие правила раскладки, axe и клавиатура (у казуала их
 * никто не требовал; research/28 §4 — сигнал, а не приговор). Нажатия и битые ссылки — настоящие ошибки.
 */
export function isHint(i: PageIssue): boolean {
  return (
    i.kind === "a11y" ||
    i.kind === "keyboard" ||
    (i.kind === "layout" && !!i.rule && HINT_RULES.has(i.rule))
  );
}

/** Есть ли что-то, ради чего возвращать к работе (не только подсказки). */
export function hasBlocking(result: PageCheckResult): boolean {
  return result.issues.some((i) => !isHint(i));
}

const TARGET = { file: "файлом", http: "через сервер" } as const;

/** Одна и та же ошибка на двух ширинах — одна строка. */
export function groupIssues(issues: PageIssue[]): string[] {
  const seen = new Map<string, { issue: PageIssue; widths: Set<number>; targets: Set<string> }>();
  for (const i of issues) {
    const key = `${i.kind}\u0000${i.rule ?? ""}\u0000${i.where}\u0000${i.kind === "layout" ? "" : i.detail}`;
    const g = seen.get(key) ?? { issue: i, widths: new Set(), targets: new Set() };
    g.widths.add(i.width);
    g.targets.add(TARGET[i.target]);
    seen.set(key, g);
  }
  return [...seen.values()].map(({ issue, widths, targets }) => {
    const at = `${[...targets].join(" и ")}, ${[...widths].sort((a, b) => a - b).join(" и ")} px`;
    const what =
      issue.kind === "layout"
        ? `${issue.rule === "root-hscroll" ? `страница шире окна (${issue.detail})` : issue.detail}${issue.where ? ` — ${issue.where}` : ""}`
        : issue.kind === "request"
          ? `не загрузился файл: ${issue.detail}`
          : issue.kind === "interaction"
            ? `${issue.detail} — ${issue.where}`
            : issue.kind === "link"
              ? `${issue.detail} — ${issue.where}`
              : issue.kind === "a11y"
                ? `доступность: ${issue.detail} (${issue.rule}) — ${issue.where}`
                : issue.kind === "keyboard"
                  ? `клавиатура: ${issue.detail} — ${issue.where}`
                  : `ошибка: ${issue.detail}`;
    return `- (${at}) ${what.slice(0, 300)}`;
  });
}

/**
 * Находки сценария (нажатия, ссылки, axe, клавиатура) строками с селекторами — для ревьюера и карточки хода.
 * Сначала ошибки, потом подсказки; не больше трёх. Ошибки загрузки и раскладки сюда не идут: их чинит возврат.
 */
export function pageFindings(result: PageCheckResult): string[] {
  const scripted = result.issues.filter((i) => SCRIPTED.has(i.kind));
  return [
    ...groupIssues(scripted.filter((i) => !isHint(i))),
    ...groupIssues(scripted.filter(isHint)).map((l) => `${l} (подсказка)`),
  ]
    .slice(0, 3)
    .map((l) => l.replace(/^- /, ""));
}
const SCRIPTED = new Set<PageIssue["kind"]>(["interaction", "link", "a11y", "keyboard"]);

export function pageCheckMessage(result: PageCheckResult, attempt: number, max: number): string {
  const lines = [
    ...groupIssues(result.issues.filter((i) => !isHint(i))),
    ...groupIssues(result.issues.filter(isHint)).map((l) => `${l} (подсказка)`),
  ];
  const shown = lines.slice(0, 6);
  if (lines.length > 6) shown.push(`- … и ещё ${lines.length - 6}`);
  const fileOnly = result.issues.length > 0 && result.issues.every((i) => i.target === "file");
  const fileHint = fileOnly
    ? "\nЧерез сервер всё хорошо, а файлом — нет: двойной клик открывает страницу как file://. Пути к файлам — относительные (./style.css, ./app.js)."
    : "";
  const last =
    attempt >= max
      ? " Это последняя попытка: если не выйдет — честно скажи пользователю, что не так со страницей."
      : "";
  const how = result.fileSkipped ? "через сервер" : "файлом и через сервер";
  return `Открыл ${result.entry} в браузере (${how}, ширина 390 и 1440 px) — есть проблемы:\n${shown.join("\n")}${fileHint}\nПочини и проверь снова.${last}`;
}
