// Чтение страниц для «Исследовать» (research/26 §3.5, §4.8): на машине пользователя (хост Pi ходит в сеть через
// системный прокси — его ставит main, proxy-discover.ts), сеть российская — откроются и российские сайты.
// Запасные: Fetch шлюза (`/v1/tools/fetch`, формат DeepSeek) и Jina Reader без ключа. Текст страницы — данные,
// а не инструкции. Дата берётся со страницы: мета article:published_time, JSON-LD, <time>; иначе — заголовок
// Last-Modified; иначе «дата неизвестна».

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
  via: "direct" | "gateway" | "jina";
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
}

export class ReadError extends Error {
  readonly status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.status = status;
  }
}

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

/** Дата публикации или изменения со страницы: самая поздняя из явных (статья могла обновиться). */
export function pageDate(html: string): { date: string; from: PageText["dateFrom"] } | undefined {
  const found: { date: string; from: NonNullable<PageText["dateFrom"]> }[] = [];
  const META =
    /<meta[^>]+(?:property|name|itemprop)=["'](article:published_time|article:modified_time|og:updated_time|datePublished|dateModified|date|DC\.date|pubdate|publish-date)["'][^>]*>/gi;
  for (const m of html.matchAll(META)) {
    const content = /content=["']([^"']+)["']/i.exec(m[0])?.[1];
    const d = isoDay(content);
    if (d) found.push({ date: d, from: "meta" });
  }
  for (const m of html.matchAll(/"(datePublished|dateModified)"\s*:\s*"([^"]+)"/g)) {
    const d = isoDay(m[2]);
    if (d) found.push({ date: d, from: "jsonld" });
  }
  if (!found.length) {
    const t = /<time[^>]+datetime=["']([^"']+)["']/i.exec(html)?.[1];
    const d = isoDay(t);
    if (d) found.push({ date: d, from: "time" });
  }
  // будущие даты (анонсы, мусор разметки) не считаем
  const today = new Date().toISOString().slice(0, 10);
  const ok = found.filter((x) => x.date <= today && x.date >= "1995-01-01");
  return ok.sort((a, b) => b.date.localeCompare(a.date))[0];
}

/** Текст HTML-страницы: без скриптов, стилей, меню и подвала; основное — из <article> или <main>, если оно есть. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "")
    .replace(/\s+/g, " ")
    .trim();
  let body = html.replace(/<!--[\s\S]*?-->/g, " ");
  body = body.replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1>/gi, " ");
  const main =
    /<article\b[\s\S]*?<\/article>/i.exec(body)?.[0] ?? /<main\b[\s\S]*?<\/main>/i.exec(body)?.[0];
  if (main && main.replace(/<[^>]+>/g, "").trim().length >= MIN_TEXT) body = main;
  else body = body.replace(/<(nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi, " ");
  body = body
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote|pre|table|ul|ol)>/gi, "\n")
    .replace(/<(td|th)\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  const text = decodeEntities(body)
    .split("\n")
    .map((l) => l.replace(/[ \t\f\v ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  return { title, text };
}

async function direct(url: string, deps: ReadDeps): Promise<PageText> {
  let res: Response;
  try {
    res = await (deps.fetchImpl ?? fetch)(url, {
      redirect: "follow",
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
        "Accept-Language": "ru,en;q=0.8",
      },
      signal: AbortSignal.timeout(deps.timeoutMs ?? 20_000),
    });
  } catch (e) {
    throw new ReadError(`не открылась: ${(e as Error).message}`);
  }
  if (!res.ok) throw new ReadError(`HTTP ${res.status}`, res.status);
  const type = res.headers.get("content-type") ?? "";
  if (/pdf|octet-stream|image\/|video\/|audio\/|zip/i.test(type)) {
    throw new ReadError(`не текст (${type.split(";")[0]})`, res.status);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  const bytes =
    buf.byteLength > (deps.maxBytes ?? 5_000_000)
      ? buf.subarray(0, deps.maxBytes ?? 5_000_000)
      : buf;
  const raw = decode(bytes, type);
  const isHtml = /html|xml/i.test(type) || /^\s*<(!doctype|html)/i.test(raw);
  const { title, text } = isHtml ? htmlToText(raw) : { title: "", text: raw.trim() };
  const fromPage = isHtml ? pageDate(raw) : undefined;
  const header = isoDay(res.headers.get("last-modified") ?? undefined);
  const page: PageText = {
    url,
    finalUrl: res.url || url,
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
    signal: AbortSignal.timeout(deps.timeoutMs ?? 30_000),
  });
  if (!res.ok) throw new ReadError(`шлюз: HTTP ${res.status}`, res.status);
  const data = (await res.json()) as { title?: string; content?: string };
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
    signal: AbortSignal.timeout(deps.timeoutMs ?? 30_000),
  });
  if (!res.ok) throw new ReadError(`Jina: HTTP ${res.status}`, res.status);
  const data = (await res.json()) as {
    data?: { title?: string; content?: string; publishedTime?: string; url?: string };
  };
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
  const errors: string[] = [];
  let first: PageText | undefined;
  try {
    first = await direct(url, deps);
    if (first.text.length >= MIN_TEXT) return first;
    errors.push("почти пустая страница (собирается скриптом?)");
  } catch (e) {
    const err = e as ReadError;
    if (err.status === 404 || err.status === 410) throw err;
    errors.push(err.message);
  }
  if (deps.gateway?.key) {
    try {
      return await viaGateway(url, deps.gateway, deps);
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  if (deps.jina !== false) {
    try {
      return await viaJina(url, deps);
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  if (first) return first;
  throw new ReadError(errors.join("; "));
}
