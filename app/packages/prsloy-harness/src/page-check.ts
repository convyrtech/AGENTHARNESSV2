// Проверка страницы, которую сделал агент, в настоящем браузере (стоп-гейт «Кода»): `index.html` файлом
// (как казуал двойным кликом) и через свой сервер на 127.0.0.1, на 390 и 1440 px. Ошибки консоли и pageerror,
// незагрузившиеся файлы, правила раскладки (горизонтальная прокрутка и т. п.). Браузер — Python-Playwright из venv
// «Дизайна» (Edge на Windows): `PRSLOY_DESIGN_PYTHON`. Нет его — проверка молча пропускается, ничего не ставим.
import { spawn } from "node:child_process";
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join, normalize, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { sanitizedEnv } from "./options.ts";
import { MODULE_SCRIPT } from "./page-paths.ts";

export const PAGE_VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
] as const;

export interface PageIssue {
  /** «файлом» или «через сервер». */
  target: "file" | "http";
  width: number;
  kind: "console" | "pageerror" | "request" | "layout";
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

/**
 * Правила раскладки внутри страницы. Пока общий модуль с ci (`lintLayout`) не вынесен — только горизонтальная
 * прокрутка документа. Функция уходит в браузер исходником: всё, что ей нужно, — внутри неё.
 */
export function basicLint(): { rule: string; selector: string; text: string; detail: string }[] {
  const out: { rule: string; selector: string; text: string; detail: string }[] = [];
  const doc = document.documentElement;
  if (doc.scrollWidth > doc.clientWidth + 1) {
    // Самый правый виновник — для «места» в возврате.
    let worst: Element | undefined;
    let right = doc.clientWidth;
    for (const el of document.body.querySelectorAll("*")) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > right + 1) {
        right = r.right;
        worst = el;
      }
    }
    const path = (el: Element) => {
      const parts: string[] = [];
      for (let n: Element | null = el; n && n !== document.body; n = n.parentElement) {
        parts.unshift(n.id ? `#${n.id}` : n.tagName.toLowerCase());
        if (n.id || parts.length >= 4) break;
      }
      return parts.join(" > ");
    };
    out.push({
      rule: "root-hscroll",
      selector: worst ? path(worst) : "html",
      text: ((worst as HTMLElement | undefined)?.innerText ?? "").trim().slice(0, 60),
      detail: `страница шире окна: ${doc.scrollWidth} px при окне ${doc.clientWidth} px`,
    });
  }
  return out;
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
                try:
                    page.goto(t["url"], wait_until="load", timeout=job["navTimeoutMs"])
                    page.wait_for_timeout(job["settleMs"])
                    page.evaluate(job["freeze"])
                    for v in page.evaluate(job["lint"], job["lintArg"]):
                        found.append({"kind": "layout", "rule": v["rule"], "where": v["selector"] + (" «" + v["text"] + "»" if v.get("text") else ""), "detail": v["detail"], **({"box": v["box"]} if v.get("box") else {})})
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

/** Мини-интерфейс Node-Playwright: тесты и замер (в приложении — Python из venv «Дизайна»). */
export interface NodePlaywright {
  chromium: {
    launch(o?: { executablePath?: string; channel?: string }): Promise<{
      newContext(o: { viewport: { width: number; height: number } }): Promise<{
        newPage(): Promise<{
          on(event: string, cb: (x: any) => void): void;
          goto(url: string, o: { waitUntil: "load"; timeout: number }): Promise<unknown>;
          waitForTimeout(ms: number): Promise<void>;
          evaluate(fn: string): Promise<unknown>;
        }>;
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
}

type RawIssue = Omit<PageIssue, "where"> & { where?: string };

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

/**
 * `off-window` ci писался для окна приложения, которое не прокручивается. Страница пользователя прокручивается
 * вниз: блок ниже первого экрана — норма. Считаем только то, что вылезло вбок. С `scrollsY: true` (ci @ 2b1c5ad)
 * так считает сам `lintLayout`; фильтр — для версии пакета без опции, убрать вместе с подключением пакета.
 */
export function belowTheFold(i: Pick<PageIssue, "rule" | "box" | "width">): boolean {
  return i.rule === "off-window" && !!i.box && i.box.x >= -1 && i.box.x + i.box.w <= i.width + 1;
}

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
  /** Исходник функции правил раскладки (`lintLayout` ci или `basicLint`). */
  lint?: string;
  timeoutMs?: number;
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
      lint: options.lint ?? basicLint.toString(),
      // Для lintLayout ci: окно чужой страницы без минимума, фокус не трогаем (он меняет состояние страницы).
      lintArg: { minWidth: 0, minHeight: 0, checkFocus: false, scrollsY: true },
      freeze: FREEZE,
      navTimeoutMs: 8_000,
      settleMs: 300,
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
      const { out, err } = await runPython(python!, job, options.timeoutMs ?? 30_000);
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
      .filter((i) => !(i.kind === "layout" && i.rule && IGNORED_RULES.has(i.rule)))
      .filter((i) => !belowTheFold(i))
      .map((i) => ({ ...i, where: i.where ?? "", detail: local(i.detail) }));
    return { entry: rel, issues, ...(job.targets.length === 1 ? { fileSkipped: true } : {}) };
  } finally {
    await server.close();
  }
}

/** Есть ли что-то, ради чего возвращать к работе (не только подсказки). */
export function hasBlocking(result: PageCheckResult): boolean {
  return result.issues.some((i) => !(i.kind === "layout" && i.rule && HINT_RULES.has(i.rule)));
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
        ? `${issue.detail}${issue.where ? ` — ${issue.where}` : ""}`
        : issue.kind === "request"
          ? `не загрузился файл: ${issue.detail}`
          : `ошибка: ${issue.detail}`;
    return `- (${at}) ${what.slice(0, 300)}`;
  });
}

export function pageCheckMessage(result: PageCheckResult, attempt: number, max: number): string {
  const hint = (i: PageIssue) => i.kind === "layout" && !!i.rule && HINT_RULES.has(i.rule);
  const lines = [
    ...groupIssues(result.issues.filter((i) => !hint(i))),
    ...groupIssues(result.issues.filter(hint)).map((l) => `${l} (подсказка)`),
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
