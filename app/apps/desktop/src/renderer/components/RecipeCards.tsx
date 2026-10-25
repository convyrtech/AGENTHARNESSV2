/**
 * «Рецепты» on the empty «Код» screen (research/19 §2.1 + §2.3): five offline starters as
 * cards; a card opens its small form (RecipeDialog). Main makes the project folder with the
 * starter files; the caller opens it and sends the filled request.
 */
import type { RecipeInfo } from "@zeno/contracts";
import { Bot, FileCode, Gamepad2, IdCard, LayoutTemplate, Sheet } from "lucide-react";
import { useEffect, useState } from "react";
import { t, type Locale } from "../lib/i18n.ts";
import { RecipeDialog } from "./RecipeDialog.tsx";
import "./code-preview-features.css";

const ICONS = {
  "id-card": IdCard,
  layout: LayoutTemplate,
  bot: Bot,
  table: Sheet,
  gamepad: Gamepad2,
};

export function RecipeCards(props: {
  locale: Locale;
  onStart: (path: string, prompt: string) => void;
}) {
  const [recipes, setRecipes] = useState<RecipeInfo[]>([]);
  const [open, setOpen] = useState<RecipeInfo | undefined>();

  useEffect(() => {
    let alive = true;
    void Promise.resolve(window.zeno?.features?.recipes?.())
      .then((list) => alive && setRecipes(list ?? []))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  if (recipes.length === 0) return null;
  return (
    <section className="recipes" data-testid="recipes" aria-labelledby="recipes-title">
      <h2 className="recipes-title" id="recipes-title">
        {t(props.locale, "features.recipes.title")}
      </h2>
      <div className="recipes-grid">
        {recipes.map((recipe) => {
          const Icon = ICONS[recipe.icon as keyof typeof ICONS] ?? FileCode;
          return (
            <button
              key={recipe.id}
              type="button"
              className="recipe-card"
              data-testid={`recipe-${recipe.id}`}
              onClick={() => setOpen(recipe)}
            >
              <Icon className="size-4 shrink-0" strokeWidth={1.75} aria-hidden />
              <span className="recipe-card-text">
                <span className="recipe-card-title">{recipe.title}</span>
                <span className="recipe-card-desc">{recipe.description}</span>
              </span>
            </button>
          );
        })}
      </div>
      <RecipeDialog
        locale={props.locale}
        recipe={open}
        onClose={() => setOpen(undefined)}
        onStart={(path, prompt) => {
          setOpen(undefined);
          props.onStart(path, prompt);
        }}
      />
    </section>
  );
}
