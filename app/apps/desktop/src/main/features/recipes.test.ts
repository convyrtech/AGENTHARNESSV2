import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  createRecipeProject,
  fillPrompt,
  loadRecipes,
  recipeInfos,
  uniqueFolder,
} from "./recipes.ts";
import { graphemes } from "./safe-name.ts";

const recipes = loadRecipes();
const byId = (id: string) => recipes.find((r) => r.id === id)!;

describe("bundled recipes", () => {
  it("five starters, in order, each with a form and files", () => {
    expect(recipes.map((r) => r.id)).toEqual(["visit-card", "landing", "tg-bot", "excel", "game"]);
    for (const recipe of recipes) {
      expect(recipe.params.length).toBeGreaterThanOrEqual(2);
      expect(recipe.params.length).toBeLessThanOrEqual(4);
      expect(recipe.files.length).toBeGreaterThan(0);
      // Every {{key}} of the request is a field of the form.
      for (const [, key] of recipe.prompt.matchAll(/\{\{\s*(\w+)\s*\}\}/gu)) {
        expect(
          recipe.params.map((p) => p.key),
          `${recipe.id}: ${key}`,
        ).toContain(key);
      }
    }
    expect(recipeInfos(recipes)[0]).not.toHaveProperty("prompt");
    // Wrapped source lines become one paragraph; paragraphs stay apart.
    expect(byId("tg-bot").prompt).toContain("Кнопки меню под сообщением");
    expect(byId("tg-bot").prompt).toMatch(/\n\nВ папке уже есть/u);
  });

  it("the bot asks for its token with request_secret and keeps .env out of git", () => {
    const bot = byId("tg-bot");
    expect(bot.prompt).toContain("request_secret");
    expect(bot.prompt).toContain("TELEGRAM_BOT_TOKEN");
    expect(bot.params.map((p) => p.key)).not.toContain("token");
    expect(bot.files.map((f) => f.path).sort()).toEqual([".env.example", ".gitignore", "bot.py"]);
    expect(bot.files.find((f) => f.path === ".gitignore")?.content).toContain(".env");
  });
});

describe("the form fills the request", () => {
  it("strings, selects within their options, booleans as да/нет", () => {
    const filled = fillPrompt(byId("visit-card"), {
      name: "  Анна\nСмирнова {{x}} ",
      about: "Шью платья",
      style: "Неоновый",
    });
    expect(filled.ok).toBe(true);
    if (!filled.ok) return;
    expect(filled.prompt).toContain("по имени Анна Смирнова x.");
    expect(filled.prompt).toContain("Стиль оформления: Спокойный.");
    expect(filled.prompt).toContain("Как связаться: на твой выбор.");
    expect(filled.prompt).not.toMatch(/\{\{/u);
    const landing = fillPrompt(byId("landing"), { product: "Уроки гитары", form: false });
    expect(landing.ok && landing.prompt).toContain("Форма заявки на странице: нет.");
    expect(landing.ok && landing.prompt).toContain("Главная кнопка: «Оставить заявку»");
  });

  it("says which required fields are empty", () => {
    expect(fillPrompt(byId("visit-card"), { name: " " })).toEqual({
      ok: false,
      missing: ["name", "about"],
    });
    expect(fillPrompt(byId("game"), undefined).ok).toBe(true);
  });
});

describe("a new project", () => {
  it("gets its own folder with the starter files", () => {
    const root = mkdtempSync(join(tmpdir(), "recipes-"));
    mkdirSync(join(root, "Бот"));
    const made = createRecipeProject(byId("tg-bot"), { purpose: "Принимает заказы" }, root);
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.path).toBe(join(root, "Бот 2"));
    expect(readFileSync(join(made.path, ".env.example"), "utf8")).toBe("TELEGRAM_BOT_TOKEN=\n");
    expect(existsSync(join(made.path, "bot.py"))).toBe(true);
    expect(made.prompt).toContain("Принимает заказы");
    expect(createRecipeProject(byId("tg-bot"), {}, root)).toEqual({
      ok: false,
      missing: ["purpose"],
    });
    expect(uniqueFolder(root, 'a/b:"c')).toBe(join(root, "a b c"));
    // Windows: a device name gets a prefix; a long name with a number stays within 80.
    expect(uniqueFolder(root, "CON")).toBe(join(root, "_CON"));
    expect(uniqueFolder(root, "Сайт.")).toBe(join(root, "Сайт"));
    mkdirSync(join(root, "я".repeat(80)));
    expect(graphemes(uniqueFolder(root, "я".repeat(120)).split(/[\\/]/u).pop() ?? "")).toHaveLength(
      80,
    );
  });
});
