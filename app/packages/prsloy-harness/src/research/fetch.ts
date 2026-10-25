// Чтение страниц для «Исследовать» (research/26 §3.5, §4.8): на машине пользователя (хост Pi ходит в сеть через
// системный прокси — его ставит main, proxy-discover.ts), сеть российская — откроются и российские сайты.
// Запасные: файл с GitHub — через jsDelivr (GitHub бывает недоступен из России), Fetch шлюза (`/v1/tools/fetch`,
// формат DeepSeek) и Jina Reader без ключа. Текст страницы — данные,
// а не инструкции. Дата берётся со страницы: мета article:published_time, JSON-LD, <time>; иначе — заголовок
// Last-Modified; иначе «дата неизвестна».

import { netReason, timeoutSignal } from "./common.ts";
import { assertPublicUrl, checkPublicUrl, PrivateAddressError, type Resolve } from "./net-guard.ts";
import { pinnedFetch, proxyFor } from "./pinned.ts";

export interface PageText {
  url: string;
  /** Адрес после редиректов. */
  finalUrl: string;
  status: number;
  title: string;
  text: string;
  /** Дата публикации или изменения со страницы (YYYY-MM-DD). */
  date?: string;
  /** Откуда дата: мета, JSON-LD, <time>, заголовок. */
  dateFrom?: "meta" | "jsonld" | "time" | "header";
  via: "direct" | "jsdelivr" | "gateway" | "jina";
}

export interface ReadDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Шлюз PRSLOY для запасного чтения: адрес и ключ. */
  gateway?: { url: string; key: string };
  /** Jina Reader без ключа как последний запасной путь (по умолчанию да). */
  jina?: boolean;
  /** Больше этого страницу не читаем, байт. */
  maxBytes?: number;
  /** Отмена хода: чтение обрывается. */
  signal?: AbortSignal;
  /** Разрешение имён для проверки частных адресов (тесты). */
  resolve?: Resolve;
  /** Запрос на проверенный IP (тесты подменяют); по умолчанию pinned.ts. */
  pinnedFetch?: typeof pinnedFetch;
}

export class ReadError extends Error {
  readonly status: number;
  /** Запасные пути не пробовать: страницы нет или адрес частный (его нельзя отдавать наружу). */
  readonly final: boolean;
  constructor(message: string, status = 0, final = false) {
    super(message);
    this.status = status;
    this.final = final || status === 404 || status === 410;
  }
}

/** Наша ошибка — её текст; чужое исключение (в нём бывает ключ из заголовка) — фиксированными словами. */
function safeReason(e: unknown): string {
  return e instanceof ReadError ? e.message : netReason(e);
}

/** Сколько редиректов проходим (каждый шаг проверяется на частный адрес). */
const MAX_REDIRECTS = 5;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
/** Меньше этого — страница, скорее всего, собирается скриптом: пробуем запасной путь. */
const MIN_TEXT = 200;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  laquo: "«",
  raquo: "»",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  bdquo: "„",
  copy: "©",
  reg: "®",
  times: "×",
  deg: "°",
  euro: "€",
  rub: "₽",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code =
        e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Кодировка из Content-Type или <meta charset>. */
function charsetOf(contentType: string, head: string): string {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  const fromMeta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  const name = (fromHeader ?? fromMeta ?? "utf-8").toLowerCase();
  return name === "cp1251" ? "windows-1251" : name;
}

function decode(bytes: Uint8Array, contentType: string): string {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
  const charset = charsetOf(contentType, head);
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function isoDay(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const t = Date.parse(value.trim());
  return Number.isNaN(t) ? undefined : new Date(t).toISOString().slice(0, 10);
}

/** Больше этого HTML не разбираем: хвост огромной страницы — не текст статьи. */
export const MAX_HTML_CHARS = 2_000_000;
/** Тег длиннее — мусор разметки; дальше не ищем его конец. */
const MAX_TAG = 4096;

/** Содержимое не текст: пропускаем целиком до закрывающего тега. */
const RAW = new Set([
  "script",
  "style",
  "noscript",
  "svg",
  "template",
  "iframe",
  "textarea",
  "title",
]);
/** Обвязка страницы: меню, шапка, подвал, формы. */
const CHROME = new Set(["nav", "header", "footer", "aside", "form"]);
/** Блоки: после закрытия — перенос строки. */
const BLOCK = new Set([
  "p",
  "div",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "tr",
  "section",
  "article",
  "blockquote",
  "pre",
  "table",
  "ul",
  "ol",
]);

/** Позиция `</name` (без учёта регистра) в самой строке, начиная с `from`; -1 — нет. */
function closingTag(html: string, name: string, from: number): number {
  for (let k = html.indexOf("</", from); k !== -1; k = html.indexOf("</", k + 2)) {
    if (html.slice(k + 2, k + 2 + name.length).toLowerCase() !== name) continue;
    const next = html[k + 2 + name.length];
    if (next === undefined || !/[A-Za-z0-9-]/.test(next)) return k;
  }
  return -1;
}

interface Scan {
  title: string;
  /** Текст без обвязки. */
  text: string;
  /** Текст первого <article>, иначе первого <main> (если есть). */
  main: string | undefined;
  /** Теги <meta …> и <time …> целиком (для даты). */
  metas: string[];
  times: string[];
  /** Содержимое <script type="application/ld+json">. */
  jsonld: string[];
}

/**
 * Разбор HTML за один проход: каждый символ смотрим один раз, поиски конца (`-->`, `>`, `</script`) идут вперёд от
 * текущего места и не возвращаются. Регулярки с ленивыми `[\s\S]*?` на враждебной странице квадратичны (200 КБ
 * «<!--» — 21 с), а разбор синхронный — таймаут его не остановит.
 */
function scanHtml(input: string): Scan {
  const html = input.length > MAX_HTML_CHARS ? input.slice(0, MAX_HTML_CHARS) : input;
  const out: string[] = [];
  const metas: string[] = [];
  const times: string[] = [];
  const jsonld: string[] = [];
  let title = "";
  let chrome = 0;
  /** Первый <article> и первый <main>: свой буфер и глубина вложенности у каждого. */
  const cap = {
    article: {
      buf: undefined as string[] | undefined,
      depth: 0,
      text: undefined as string | undefined,
    },
    main: {
      buf: undefined as string[] | undefined,
      depth: 0,
      text: undefined as string | undefined,
    },
  };
  const emit = (t: string) => {
    if (chrome === 0) out.push(t);
    cap.article.buf?.push(t);
    cap.main.buf?.push(t);
  };
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      emit(html.slice(i));
      break;
    }
    if (lt > i) emit(html.slice(i, lt));
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      emit(" ");
      i = end === -1 ? n : end + 3;
      continue;
    }
    const closing = html[lt + 1] === "/";
    const nameStart = closing ? lt + 2 : lt + 1;
    let j = nameStart;
    while (j < n && /[A-Za-z0-9-]/.test(html[j]!)) j++;
    if (j === nameStart || !/[a-z]/i.test(html[nameStart]!)) {
      // «<» в тексте, «<!doctype», «<?xml»: не тег текста
      if (html[lt + 1] === "!" || html[lt + 1] === "?") {
        const end = html.indexOf(">", lt + 2);
        i = end === -1 ? n : end + 1;
      } else {
        emit("<");
        i = lt + 1;
      }
      continue;
    }
    // имя тега — только ASCII, его и приводим к нижнему регистру: toLowerCase всей строки сдвигает позиции
    // («İ» → два знака), и найденное по копии место уже не то в оригинале
    const name = html.slice(nameStart, j).toLowerCase();
    const gt = html.indexOf(">", j);
    if (gt === -1 || gt - lt > MAX_TAG) {
      // незакрытый или гигантский тег: дальше разметки нет
      i = gt === -1 ? n : gt + 1;
      continue;
    }
    const tag = html.slice(lt, gt + 1);
    i = gt + 1;
    if (closing) {
      if (CHROME.has(name) && chrome > 0) chrome--;
      if (name === "article" || name === "main") {
        const c = cap[name];
        if (c.buf && --c.depth === 0) {
          c.text = c.buf.join("");
          c.buf = undefined;
        }
      }
      if (BLOCK.has(name)) emit("\n");
      else emit(" ");
      continue;
    }
    if (name === "meta") metas.push(tag);
    if (name === "time") times.push(tag);
    if (RAW.has(name) && !tag.endsWith("/>")) {
      const close = closingTag(html, name, i);
      const body = html.slice(i, close === -1 ? n : close);
      if (name === "title" && !title) title = body;
      if (name === "script" && /application\/ld\+json/i.test(tag)) jsonld.push(body);
      if (close === -1) i = n;
      else {
        const end = html.indexOf(">", close);
        i = end === -1 ? n : end + 1;
      }
      emit(" ");
      continue;
    }
    if (CHROME.has(name)) chrome++;
    if (name === "article" || name === "main") {
      const c = cap[name];
      if (c.buf) c.depth++;
      else if (c.text === undefined) {
        c.buf = [];
        c.depth = 1;
      }
    }
    if (name === "br" || name === "hr") emit("\n");
    else emit(" ");
  }
  for (const c of [cap.article, cap.main]) if (c.buf) c.text = c.buf.join("");
  return {
    title,
    text: out.join(""),
    main: cap.article.text ?? cap.main.text,
    metas,
    times,
    jsonld,
  };
}

function tidy(text: string): string {
  return decodeEntities(text)
    .split("\n")
    .map((l) => l.replace(/[ \t\f\v\u00a0]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/** Дата публикации или изменения со страницы: самая поздняя из явных (статья могла обновиться). */
export function pageDate(html: string): { date: string; from: PageText["dateFrom"] } | undefined {
  return dateOf(scanHtml(html));
}

const META_NAME =
  /(?:property|name|itemprop)=["'](article:published_time|article:modified_time|og:updated_time|datePublished|dateModified|date|DC\.date|pubdate|publish-date)["']/i;

function dateOf(scan: Scan): { date: string; from: PageText["dateFrom"] } | undefined {
  const found: { date: string; from: NonNullable<PageText["dateFrom"]> }[] = [];
  for (const m of scan.metas) {
    if (!META_NAME.test(m)) continue;
    const d = isoDay(/content=["']([^"']+)["']/i.exec(m)?.[1]);
    if (d) found.push({ date: d, from: "meta" });
  }
  for (const block of scan.jsonld) {
    for (const m of block.matchAll(/"(datePublished|dateModified)"\s*:\s*"([^"]{1,64})"/g)) {
      const d = isoDay(m[2]);
      if (d) found.push({ date: d, from: "jsonld" });
    }
  }
  if (!found.length) {
    for (const t of scan.times) {
      const d = isoDay(/datetime=["']([^"']+)["']/i.exec(t)?.[1]);
      if (d) {
        found.push({ date: d, from: "time" });
        break;
      }
    }
  }
  // будущие даты (анонсы, мусор разметки) не считаем
  const today = new Date().toISOString().slice(0, 10);
  const ok = found.filter((x) => x.date <= today && x.date >= "1995-01-01");
  return ok.sort((a, b) => b.date.localeCompare(a.date))[0];
}

/** Текст HTML-страницы: без скриптов, стилей, меню и подвала; основное — из <article> или <main>, если оно есть. */
export function htmlToText(html: string): { title: string; text: string } {
  return textOf(scanHtml(html));
}

function textOf(scan: Scan): { title: string; text: string } {
  const title = decodeEntities(scan.title).replace(/\s+/g, " ").trim();
  const main = scan.main !== undefined ? tidy(scan.main) : "";
  return { title, text: main.length >= MIN_TEXT ? main : tidy(scan.text) };
}

/** Сколько тела ответа читаем по умолчанию, байт. */
export const MAX_BODY_BYTES = 5_000_000;
/** Тела-тексты: HTML, XML (RSS, Atom), JSON, простой текст. Нет типа — смотрим на сами байты. */
const TEXT_TYPE = /^(text\/[\w.+-]+|application\/(xhtml\+xml|xml|json|[\w.-]+\+(xml|json)))$/i;

export function isTextType(contentType: string | null): boolean {
  const t = (contentType ?? "").split(";")[0]!.trim();
  return t === "" || TEXT_TYPE.test(t);
}

/** Тело ответа потоком до `max` байт; дальше — обрыв чтения (остальное не скачиваем). */
export async function readCapped(res: Response, max = MAX_BODY_BYTES): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(await res.arrayBuffer()).subarray(0, max);
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < max) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = max - size;
      parts.push(value.byteLength > room ? value.subarray(0, room) : value);
      size += Math.min(value.byteLength, room);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

async function cappedJson<T>(res: Response, max = MAX_BODY_BYTES): Promise<T> {
  return JSON.parse(new TextDecoder().decode(await readCapped(res, max))) as T;
}

async function direct(url: string, deps: ReadDeps): Promise<PageText> {
  let res: Response | undefined;
  let current = url;
  const signal = timeoutSignal(deps.timeoutMs ?? 20_000, deps.signal);
  let ips: string[];
  try {
    ({ ips } = await checkPublicUrl(current, deps.resolve));
  } catch (e) {
    throw new ReadError(
      e instanceof PrivateAddressError ? e.message : "это не адрес страницы",
      0,
      true,
    );
  }
  const headers = {
    "User-Agent": UA,
    Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
    "Accept-Language": "ru,en;q=0.8",
  };
  for (let hop = 0; ; hop++) {
    try {
      // соединение — на проверенный IP (если он известен и между нами нет прокси): DNS не успеет подменить адрес
      const pinTo = !deps.fetchImpl && ips[0] && !proxyFor(new URL(current)) ? ips[0] : undefined;
      res = pinTo
        ? await (deps.pinnedFetch ?? pinnedFetch)(current, { headers, signal }, pinTo)
        : await (deps.fetchImpl ?? fetch)(current, {
            // редиректы — сами: каждый шаг проверяем, не ведёт ли он на частный адрес
            redirect: "manual",
            headers,
            signal,
          });
    } catch (e) {
      throw new ReadError(`не открылась: ${netReason(e)}`);
    }
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) break;
    await res.body?.cancel().catch(() => undefined);
    if (hop >= MAX_REDIRECTS) throw new ReadError("слишком много редиректов");
    let next: string;
    try {
      next = new URL(location, current).toString();
      ({ ips } = await checkPublicUrl(next, deps.resolve));
    } catch (e) {
      throw new ReadError(
        `редирект на ${e instanceof PrivateAddressError ? "частный адрес" : "неверный адрес"} — не читаем`,
        0,
        true,
      );
    }
    current = next;
  }
  if (!res.ok) throw new ReadError(`HTTP ${res.status}`, res.status);
  const type = res.headers.get("content-type") ?? "";
  if (!isTextType(type)) {
    await res.body?.cancel().catch(() => undefined);
    throw new ReadError(`не текст (${type.split(";")[0]})`, res.status);
  }
  const bytes = await readCapped(res, deps.maxBytes ?? MAX_BODY_BYTES);
  const raw = decode(bytes, type);
  const isHtml = /html|xml/i.test(type) || /^\s*<(!doctype|html)/i.test(raw);
  const scan = isHtml ? scanHtml(raw) : undefined;
  const { title, text } = scan ? textOf(scan) : { title: "", text: raw.trim() };
  const fromPage = scan ? dateOf(scan) : undefined;
  const header = isoDay(res.headers.get("last-modified") ?? undefined);
  const page: PageText = {
    url,
    finalUrl: current,
    status: res.status,
    title,
    text,
    via: "direct",
  };
  if (fromPage) {
    page.date = fromPage.date;
    if (fromPage.from) page.dateFrom = fromPage.from;
  } else if (header) {
    page.date = header;
    page.dateFrom = "header";
  }
  return page;
}

async function viaGateway(
  url: string,
  gw: { url: string; key: string },
  deps: ReadDeps,
): Promise<PageText> {
  const base = gw.url.replace(/\/+$/, "").replace(/\/v1$/, "");
  const res = await (deps.fetchImpl ?? fetch)(`${base}/v1/tools/fetch`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${gw.key}` },
    body: JSON.stringify({ url }),
    signal: timeoutSignal(deps.timeoutMs ?? 30_000, deps.signal),
  });
  if (!res.ok) throw new ReadError(`шлюз: HTTP ${res.status}`, res.status);
  const data = await cappedJson<{ title?: string; content?: string }>(res, deps.maxBytes).catch(
    () => undefined,
  );
  if (!data?.content) throw new ReadError("шлюз: пустая страница");
  return {
    url,
    finalUrl: url,
    status: 200,
    title: data.title ?? "",
    text: data.content,
    via: "gateway",
  };
}

async function viaJina(url: string, deps: ReadDeps): Promise<PageText> {
  const res = await (deps.fetchImpl ?? fetch)(`https://r.jina.ai/${url}`, {
    headers: { Accept: "application/json" },
    signal: timeoutSignal(deps.timeoutMs ?? 30_000, deps.signal),
  });
  if (!res.ok) throw new ReadError(`Jina: HTTP ${res.status}`, res.status);
  const data = await cappedJson<{
    data?: { title?: string; content?: string; publishedTime?: string; url?: string };
  }>(res, deps.maxBytes).catch(() => undefined);
  if (!data?.data?.content) throw new ReadError("Jina: пустая страница");
  const date = isoDay(data.data.publishedTime);
  return {
    url,
    finalUrl: data.data.url ?? url,
    status: 200,
    title: data.data.title ?? "",
    text: data.data.content,
    ...(date ? { date, dateFrom: "meta" as const } : {}),
    via: "jina",
  };
}

/**
 * Тот же файл с GitHub через jsDelivr: `github.com/<o>/<r>/blob/<ref>/<путь>`, `raw.githubusercontent.com/<o>/<r>/<ref>/
 * <путь>`, корень репозитория — его README. Иначе undefined.
 */
export function jsdelivrUrl(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  const host = u.hostname.replace(/^www\./, "");
  const parts = u.pathname.split("/").filter(Boolean);
  const gh = (o: string, r: string, ref: string | undefined, path: string[]) =>
    `https://cdn.jsdelivr.net/gh/${o}/${r.replace(/\.git$/, "")}${ref ? `@${ref}` : ""}/${path.join("/")}`;
  if (host === "raw.githubusercontent.com" && parts.length >= 4) {
    const [o, r, ...rest] = parts as [string, string, ...string[]];
    const ref = rest[0] === "refs" && rest[1] === "heads" ? rest[2] : rest[0];
    const path = rest[0] === "refs" && rest[1] === "heads" ? rest.slice(3) : rest.slice(1);
    return path.length ? gh(o, r, ref, path) : undefined;
  }
  if (host !== "github.com" || parts.length < 2) return undefined;
  const [o, r, kind, ref, ...path] = parts as [string, string, ...string[]];
  if (parts.length === 2) return gh(o, r, undefined, ["README.md"]);
  if ((kind === "blob" || kind === "raw") && ref && path.length) return gh(o, r, ref, path);
  return undefined;
}

/**
 * Страница как текст. Сначала с машины пользователя; не открылась, пустая или собирается скриптом — Fetch шлюза,
 * потом Jina Reader. 404 и 410 — страницы нет, запасные пути не пробуем.
 */
export async function readPage(url: string, deps: ReadDeps = {}): Promise<PageText> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ReadError("это не адрес страницы");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new ReadError("только http и https");
  if (parsed.username || parsed.password)
    throw new ReadError("адрес с логином и паролем не читаем");
  // частный адрес не читаем и в запасные пути (шлюз, Jina, jsDelivr) не отдаём
  try {
    await assertPublicUrl(url, deps.resolve);
  } catch (e) {
    throw new ReadError(
      e instanceof PrivateAddressError ? e.message : "это не адрес страницы",
      0,
      true,
    );
  }
  const errors: string[] = [];
  let first: PageText | undefined;
  try {
    first = await direct(url, deps);
    if (first.text.length >= MIN_TEXT) return first;
    errors.push("почти пустая страница (собирается скриптом?)");
  } catch (e) {
    const err = e as ReadError;
    if (err.final) throw err;
    errors.push(err.message);
  }
  const cdn = first ? undefined : jsdelivrUrl(url);
  if (cdn) {
    try {
      const page = await direct(cdn, deps);
      return { ...page, url, via: "jsdelivr" };
    } catch (e) {
      errors.push(`jsDelivr: ${safeReason(e)}`);
    }
  }
  if (deps.gateway?.key) {
    try {
      return await viaGateway(url, deps.gateway, deps);
    } catch (e) {
      errors.push(`шлюз: ${safeReason(e)}`);
    }
  }
  if (deps.jina !== false) {
    try {
      return await viaJina(url, deps);
    } catch (e) {
      errors.push(`Jina: ${safeReason(e)}`);
    }
  }
  if (first) return first;
  throw new ReadError(errors.join("; "));
}
