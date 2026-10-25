import { describe, expect, it } from "vite-plus/test";
import { siteUrl } from "./site-url.ts";

describe("siteUrl", () => {
  it("finds the owner's site the way owners write it", () => {
    expect(siteUrl("привет, сделай лендинг для PRSLOY, чтоб было круто. домен prsloy.online")).toBe(
      "https://prsloy.online",
    );
    expect(siteUrl("наш сайт https://zerno-coffee.ru/menu, сделай похоже")).toBe(
      "https://zerno-coffee.ru/menu",
    );
    expect(siteUrl("кабинет на lk.prsloy.online, вход там же.")).toBe("https://lk.prsloy.online");
    expect(siteUrl("вот наш сайт: кофейня-зерно.рф")).toBe("https://кофейня-зерно.рф");
  });

  it("ignores e-mail, files and plain words with dots", () => {
    expect(siteUrl("пишите на hello@zerno.ru")).toBeUndefined();
    expect(siteUrl("вот логотип logo.png и меню menu.pdf")).toBeUndefined();
    expect(siteUrl("а а а")).toBeUndefined();
    expect(siteUrl("т.е. как рекомендуешь")).toBeUndefined();
  });
});
