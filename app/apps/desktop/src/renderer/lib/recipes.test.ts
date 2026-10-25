import type { RecipeParam } from "@zeno/contracts";
import { describe, expect, it } from "vite-plus/test";
import { initialValues, missingFields } from "./recipes.ts";

const params: RecipeParam[] = [
  { key: "name", label: "Как зовут?", inputType: "string", required: true },
  { key: "job", label: "Чем заняты?", inputType: "string", required: false, default: "Шью" },
  { key: "style", label: "Стиль", inputType: "select", required: false, options: ["А", "Б"] },
  { key: "form", label: "Форма", inputType: "boolean", required: false, default: true },
];

describe("recipe form", () => {
  it("starts from the recipe's defaults", () => {
    expect(initialValues(params)).toEqual({ name: "", job: "Шью", style: "А", form: true });
  });

  it("names the required fields still empty", () => {
    expect(missingFields(params, { name: "  " })).toEqual(["name"]);
    expect(missingFields(params, { name: "Анна" })).toEqual([]);
  });
});
