// Журнал источников «Исследовать» (research/26 §4.4, §4.8): номер [n] выдаёт код, а не модель; у номера — адрес,
// заголовок, дата, откуда найден, путь к полному тексту страницы и цитаты, которые на него ссылаются. Одна страница —
// один номер: адреса сводятся (без www., #якоря, utm_* и хвостового «/»). Идея журнала и нормализации — Hermes
// Agent `sources.py` (MIT, Nous Research); код свой.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

export interface LedgerSource {
  n: number;
  url: string;
  title: string;
  /** Дата публикации (YYYY-MM-DD), если известна. */
  date?: string;
  /** Откуда дата: поставщик поиска, мета страницы, заголовок. */
  dateFrom?: string;
  /** Кто нашёл: поставщик поиска или «прочитано по адресу». */
  foundBy: string;
  /** Отрывок из выдачи поиска. */
  snippet?: string;
  /** Полный текст страницы в файле, когда страницу прочитали. */
  textPath?: string;
  /** Код ответа при чтении. */
  status?: number;
  /** Дословные цитаты, на которые ссылаются утверждения. */
  quotes: string[];
}

const TRACKING = /^(utm_\w+|yclid|gclid|fbclid|_openstat|from|ref|ref_src)$/i;

/** Адрес для сравнения: одна страница — одна запись. */
export function normalizeUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return raw.trim();
  }
  u.hash = "";
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
  for (const key of Array.from(u.searchParams.keys()))
    if (TRACKING.test(key)) u.searchParams.delete(key);
  u.searchParams.sort();
  let s = u.toString();
  if (u.pathname !== "/" && s.endsWith("/") && !u.search) s = s.slice(0, -1);
  if (u.pathname === "/" && !u.search) s = s.replace(/\/$/, "");
  return s.replace(/^http:\/\//, "https://");
}

export class SourceLedger {
  readonly #dir: string;
  readonly #byKey = new Map<string, LedgerSource>();
  readonly #list: LedgerSource[] = [];

  /** `dir` — папка журнала этой сессии (ledger.json и тексты страниц). */
  constructor(dir: string) {
    this.#dir = dir;
    const file = join(dir, "ledger.json");
    if (existsSync(file)) {
      try {
        for (const s of JSON.parse(readFileSync(file, "utf8")) as LedgerSource[]) {
          this.#list.push(s);
          this.#byKey.set(normalizeUrl(s.url), s);
        }
      } catch {
        // испорченный журнал: начинаем новый, старые тексты останутся в папке
      }
    }
  }

  get dir(): string {
    return this.#dir;
  }

  /** Номер источника: существующий для той же страницы или новый. Поля дополняются, а не затираются. */
  add(source: Omit<LedgerSource, "n" | "quotes"> & { quotes?: string[] }): LedgerSource {
    const key = normalizeUrl(source.url);
    const known = this.#byKey.get(key);
    if (known) {
      if (!known.date && source.date) {
        known.date = source.date;
        if (source.dateFrom) known.dateFrom = source.dateFrom;
      }
      if (!known.title && source.title) known.title = source.title;
      if (!known.snippet && source.snippet) known.snippet = source.snippet;
      this.#save();
      return known;
    }
    const entry: LedgerSource = {
      ...source,
      n: this.#list.length + 1,
      quotes: source.quotes ?? [],
    };
    this.#list.push(entry);
    this.#byKey.set(key, entry);
    this.#save();
    return entry;
  }

  get(n: number): LedgerSource | undefined {
    return this.#list[n - 1];
  }

  find(url: string): LedgerSource | undefined {
    return this.#byKey.get(normalizeUrl(url));
  }

  list(): readonly LedgerSource[] {
    return this.#list;
  }

  /** Полный текст прочитанной страницы — в файл; путь запоминается у источника. */
  saveText(
    n: number,
    page: { text: string; title?: string; date?: string; dateFrom?: string; status?: number },
  ): string {
    const s = this.get(n);
    if (!s) throw new Error(`нет источника [${n}]`);
    mkdirSync(join(this.#dir, "pages"), { recursive: true });
    const name = `${n}-${createHash("sha1").update(normalizeUrl(s.url)).digest("hex").slice(0, 8)}.txt`;
    const path = join(this.#dir, "pages", name);
    writeFileSync(path, page.text, "utf8");
    s.textPath = path;
    if (page.status !== undefined) s.status = page.status;
    if (!s.title && page.title) s.title = page.title;
    if (page.date && (!s.date || s.dateFrom === "header")) {
      s.date = page.date;
      if (page.dateFrom) s.dateFrom = page.dateFrom;
    }
    this.#save();
    return path;
  }

  /** Сохранённый текст страницы, если её читали. */
  text(n: number): string | undefined {
    const p = this.get(n)?.textPath;
    return p && existsSync(p) ? readFileSync(p, "utf8") : undefined;
  }

  addQuote(n: number, quote: string): void {
    const s = this.get(n);
    if (!s) throw new Error(`нет источника [${n}]`);
    if (!s.quotes.includes(quote)) s.quotes.push(quote);
    this.#save();
  }

  #save(): void {
    mkdirSync(this.#dir, { recursive: true });
    writeFileSync(join(this.#dir, "ledger.json"), JSON.stringify(this.#list, null, 1), "utf8");
  }
}
