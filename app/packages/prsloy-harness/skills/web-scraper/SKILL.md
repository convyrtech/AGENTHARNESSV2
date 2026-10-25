---
name: web-scraper
description: "Парсер сайта: собрать цены, товары, объявления в таблицу. requests + BeautifulSoup, robots.txt и паузы, кодировка, сохранение в CSV/Excel; защиту (Cloudflare, капчу) не обходим."
---

# Парсер сайта

Tools: **requests** + **beautifulsoup4** in a project venv (`.venv/Scripts/python -m pip install requests beautifulsoup4`).

## Before writing code

1. Look for a cleaner source first: an official API, an export button, an RSS feed, a sitemap. Say if you found one.
2. Read `robots.txt` with `urllib.robotparser`: skip what `can_fetch()` forbids, honour `crawl_delay()`.
3. Open one page with `requests` and check the data is in the HTML. If the page builds itself with JavaScript
   (the data is not in `response.text`), say so: a simple parser will not see it.

## The parser

- One `requests.Session()`, a clear `User-Agent` (name of the script), `timeout=20` on every request,
  `response.raise_for_status()`.
- A pause between requests (`time.sleep(1–2)`, or the site's crawl delay). Never parallel requests to one site.
- Russian sites may send cp1251 without saying so: if the text is garbled, set
  `response.encoding = response.apparent_encoding` before `response.text`.
- Parse with `BeautifulSoup(html, "html.parser")`, pick data with CSS selectors (`select`, `select_one`), make
  links absolute with `urllib.parse.urljoin`. Clean values (`get_text(strip=True)`, prices to numbers).
- Save to `result.csv` with `encoding="utf-8-sig"` (opens in Excel with Cyrillic) or to xlsx (see excel-csv).
- Start small: one page → check the rows → then pagination with a hard limit on pages.

## Stop and tell the user

- 403/429, a captcha, a «checking your browser» page (Cloudflare and similar): stop. Do not rotate proxies, fake
  browsers or solve captchas. Offer the honest options: an API, an export, asking the site owner.
- Pages behind a login, or personal data of people: do not collect without the user's clear right to it.

## Sources

- Requests: https://requests.readthedocs.io/en/latest/
- Beautiful Soup: https://www.crummy.com/software/BeautifulSoup/bs4/doc/
- robots.txt parser: https://docs.python.org/3/library/urllib.robotparser.html
- robots.txt standard (RFC 9309): https://www.rfc-editor.org/rfc/rfc9309
