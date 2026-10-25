// Уровень источника кодом по адресу и заголовку (research/26 §4.2, сбой 3 владельца: «реклама за правду»):
// код и релизы, документация и законы, статьи и СМИ — выше форумов; SEO-подборки «топ-10 / лучшие» и блог продавца,
// который сравнивает себя с конкурентами, — маркетинг. Это подсказка модели и журналу, а не приговор: метку
// «заявлено продавцом» по утверждениям ставит конвейер (R2). Идея уровней — STORM (MIT); код свой.

export type SourceTier = "code" | "releases" | "docs" | "articles" | "forums" | "marketing";

export const TIER_LABEL: Record<SourceTier, string> = {
  code: "код",
  releases: "релизы",
  docs: "доки",
  articles: "статьи",
  forums: "форумы",
  marketing: "маркетинг/SEO",
};

const CODE_HOSTS =
  /(^|\.)(github\.com|gitlab\.com|codeberg\.org|bitbucket\.org|sr\.ht|gitflic\.ru|gitverse\.ru)$/;
const REGISTRY_HOSTS =
  /(^|\.)(npmjs\.com|registry\.npmjs\.org|pypi\.org|crates\.io|rubygems\.org|packagist\.org|pkg\.go\.dev|nuget\.org|endoflife\.date|hub\.docker\.com)$/;
const GOV =
  /(^|\.)(gov\.ru|gov|gov\.uk|europa\.eu|cbr\.ru|consultant\.ru|garant\.ru|pravo\.gov\.ru|kremlin\.ru|government\.ru|nalog\.ru)$/;
const FORUM_HOSTS =
  /(^|\.)(habr\.com|reddit\.com|stackoverflow\.com|stackexchange\.com|superuser\.com|news\.ycombinator\.com|vc\.ru|pikabu\.ru|dtf\.ru|4pda\.to|forum\.[\w.-]+|discord\.com|t\.me|quora\.com)$/;
const ARTICLE_HOSTS =
  /(^|\.)(wikipedia\.org|arxiv\.org|nature\.com|science\.org|acm\.org|ieee\.org|reuters\.com|apnews\.com|bbc\.co\.uk|bbc\.com|theverge\.com|arstechnica\.com|rbc\.ru|kommersant\.ru|vedomosti\.ru|tass\.ru|ria\.ru|interfax\.ru|cnews\.ru|3dnews\.ru)$/;
const SEO_TITLE =
  /\b(top|best)\s*\d*\b|\bvs\.?\b|\balternatives?\b|топ[-\s]?\d+|лучши[ех]|рейтинг|обзор\s+\d+|сравнени[ея]\s+\d+|\d+\s+(лучших|сервисов|программ)/i;

function parse(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

export function tierOf(url: string, title = ""): SourceTier {
  const u = parse(url);
  if (!u) return "articles";
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const path = u.pathname.toLowerCase();
  if (SEO_TITLE.test(title) && !CODE_HOSTS.test(host) && !GOV.test(host)) return "marketing";
  if (CODE_HOSTS.test(host)) {
    if (/\/(releases|tags|changelog)|changelog|release/.test(path)) return "releases";
    if (/\/(issues|discussions|pull)\//.test(path)) return "forums";
    return "code";
  }
  if (
    REGISTRY_HOSTS.test(host) ||
    /changelog|release[-_]?notes|\/releases?\b|whats-?new|what's new/.test(path)
  )
    return "releases";
  if (GOV.test(host)) return "docs";
  if (
    /^(docs|developer|developers|dev|learn|api-docs|help|support|reference)\./.test(host) ||
    /\/(docs|documentation|reference|api|manual|guide|guides)(\/|$)/.test(path) ||
    /\/(pricing|terms|tos|legal|license)(\/|$)/.test(path)
  )
    return "docs";
  if (FORUM_HOSTS.test(host) || /\/(forum|forums|community|questions|thread|topic)s?\//.test(path))
    return "forums";
  if (ARTICLE_HOSTS.test(host)) return "articles";
  if (/\/blog\//.test(path) && SEO_TITLE.test(title)) return "marketing";
  return "articles";
}
