/**
 * «Рецепты» in the renderer (research/19 §2.1): the form's starting values and what is
 * still missing. Main owns the recipes and fills the request.
 */
import type { RecipeParam } from "@zeno/contracts";

export type RecipeValues = Record<string, string | boolean>;

export function initialValues(params: readonly RecipeParam[]): RecipeValues {
  const values: RecipeValues = {};
  for (const p of params) {
    if (p.inputType === "boolean") values[p.key] = p.default === true;
    else if (p.inputType === "select") values[p.key] = String(p.default ?? p.options?.[0] ?? "");
    else values[p.key] = typeof p.default === "string" ? p.default : "";
  }
  return values;
}

/** Keys of required fields still empty (only spaces count as empty). */
export function missingFields(params: readonly RecipeParam[], values: RecipeValues): string[] {
  return params
    .filter((p) => p.required && p.inputType === "string")
    .filter((p) => !String(values[p.key] ?? "").trim())
    .map((p) => p.key);
}
