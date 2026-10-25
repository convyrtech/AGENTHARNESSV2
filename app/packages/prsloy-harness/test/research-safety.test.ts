// Ревью #23 перед включением webTools: враждебные страницы, адреса, ключи. Каждый тест падает без своей правки.
import { describe, expect, it } from "vite-plus/test";
import { htmlToText, MAX_HTML_CHARS, pageDate } from "../src/research/fetch.ts";

const fast = (f: () => unknown) => {
  const t0 = performance.now();
  f();
  return performance.now() - t0;
};

describe("HTML is parsed in one pass (review #23, item 1)", () => {
  it("hostile markup does not hang the host: 200 KB of «<!--», «<meta», «<article», «<script»", () => {
    for (const piece of [
      "<!--",
      "<meta property='date' ",
      "<article>",
      "<script>",
      "<a ",
      "<time datetime='",
    ]) {
      const html = piece.repeat(Math.ceil(200_000 / piece.length));
      const ms = fast(() => {
        htmlToText(html);
        pageDate(html);
      });
      expect(ms, piece).toBeLessThan(500);
    }
  });

  it("the input is capped before parsing", () => {
    const html = `<p>${"a".repeat(MAX_HTML_CHARS)}</p><p>ХВОСТ</p>`;
    expect(htmlToText(html).text).not.toContain("ХВОСТ");
  });

  it("the same text as before: article preferred, chrome dropped, raw elements skipped", () => {
    const body = "Текст статьи. ".repeat(30);
    const html =
      "<!doctype html><html><head><title>Заголовок &amp; ещё</title>" +
      '<meta property="article:published_time" content="2026-10-01T10:00:00Z">' +
      '<script type="application/ld+json">{"dateModified":"2026-10-20"}</script></head><body>' +
      "<nav>Меню</nav><main><p>Лид</p><article><h1>Статья</h1><p>" +
      body +
      "</p><script>var x = '<p>не текст</p>';</script><!-- комментарий --></article></main>" +
      "<footer>Подвал</footer></body></html>";
    const { title, text } = htmlToText(html);
    expect(title).toBe("Заголовок & ещё");
    expect(text.startsWith("Статья\nТекст статьи.")).toBe(true);
    expect(text).not.toMatch(/Меню|Подвал|не текст|комментарий|Лид/);
    expect(pageDate(html)).toEqual({ date: "2026-10-20", from: "jsonld" });
    // нет article — main; нет main — всё без обвязки
    expect(htmlToText(`<nav>Меню</nav><main><p>${body}</p></main>`).text).not.toContain("Меню");
    expect(htmlToText(`<nav>Меню</nav><p>Коротко</p><footer>Подвал</footer>`).text).toBe("Коротко");
    expect(htmlToText("a < b и c > d").text).toBe("a < b и c > d");
  });
});
