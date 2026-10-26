// Сайт-визитка (#36): правила стенда в настоящем Chromium — плохая страница ловится по каждому правилу, эталон чист.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
// @ts-expect-error — .mjs стенда без типов
import { checkLanding, inventedNumbers } from "../bench/lib/landing-check.mjs";
import { loadPlaywright } from "./playwright.ts";

const root = mkdtempSync(join(tmpdir(), "prsloy-landing-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const BRIEF = "Кофейня «Зерно» на Садовой, 12, с 8 утра до 22.";

const BAD = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<link rel="stylesheet" href="/style.css"></head><body>
<header><p style="text-transform:uppercase">лучший кофе</p><h1>Кофейня Зерно</h1><a href="#" style="background:#000;color:#fff;padding:8px">Подробнее</a></header>
<section><h1>Ещё один h1</h1><div style="width:1200px">Lorem ipsum dolor sit amet</div></section>
<section><p>01</p><p>02</p><p>Нам доверяют 500+ клиентов, работаем 15 лет.</p></section>
<section><h2>Отзывы</h2><p>«Лучший кофе в городе, хожу каждый день» — Ирина</p></section>
<section><form><input name="name"><button>Отправить</button></form><img src="cup.png"></section>
<script>document.querySelector("form").onsubmit = () => alert("Спасибо!");</script>
</body></html>`;

describe("landing checks (#36)", () => {
  it("numbers: only those from the brief, phone placeholders, times and © year are allowed", () => {
    expect(
      inventedNumbers("Садовая, 12. С 8:00 до 22:00. +7 (000) 000-00-00. © 2026", BRIEF),
    ).toEqual([]);
    expect(inventedNumbers("500+ клиентов, 15 лет, капучино 250 ₽", BRIEF)).toEqual([
      "500",
      "15",
      "250",
    ]);
  });

  it("a bad page fails on every rule; an empty folder fails", async (t) => {
    if (!(await loadPlaywright())) return t.skip();
    const dir = join(root, "bad");
    mkdirOk(dir);
    writeFileSync(join(dir, "index.html"), BAD);
    const r = await checkLanding(dir, BRIEF, ["Зерно"]);
    expect(r.ok).toBe(false);
    const all = r.failures.join("\n");
    for (const expected of [
      "нет <title>",
      "нет meta description",
      "путь не относительный",
      "alert()",
      "прокрутка вбок",
      "h1 на странице 2",
      "главная кнопка «Подробнее»",
      "секции без заголовка",
      "картинок без alt: 1",
      "нумерация «01/02/03»",
      "подписи капслоком над заголовками",
      "в форме нет поля телефона или email",
      "в форме нет обязательных полей",
      "заглушка-рыба",
      "отзывы с именами",
      "числа не из брифа: 500, 15",
    ])
      expect(all, expected).toContain(expected);
    const empty = join(root, "empty");
    mkdirOk(empty);
    expect((await checkLanding(empty, BRIEF)).ok).toBe(false);
  }, 60_000);
});

function mkdirOk(dir: string) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}
