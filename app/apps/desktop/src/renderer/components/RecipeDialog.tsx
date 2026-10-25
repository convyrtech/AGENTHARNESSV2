/**
 * The small form of a recipe (research/19 §2.1, by the idea of goose's ParameterInputModal):
 * 2–4 questions, then main makes the project folder with the starter and the filled
 * request goes to the agent. Text fields, choices as buttons (no native <select>), a yes/no
 * switch; every control is labelled, a missing answer says so next to its field.
 */
import type { RecipeInfo } from "@zeno/contracts";
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { t, type Locale } from "../lib/i18n.ts";
import { initialValues, missingFields, type RecipeValues } from "../lib/recipes.ts";
import "./code-preview-features.css";

export function RecipeDialog(props: {
  locale: Locale;
  recipe: RecipeInfo | undefined;
  onClose: () => void;
  onStart: (path: string, prompt: string) => void;
}) {
  const tr = (key: Parameters<typeof t>[1], vars?: Record<string, string>) =>
    t(props.locale, key, vars);
  const recipe = props.recipe;
  const base = useId();
  const [values, setValues] = useState<RecipeValues>({});
  const [shown, setShown] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (!recipe) return;
    setValues(initialValues(recipe.params));
    setShown([]);
    setError(undefined);
    setBusy(false);
  }, [recipe]);

  if (!recipe) return null;
  const set = (key: string, value: string | boolean) => {
    setValues((v) => ({ ...v, [key]: value }));
    setShown((keys) => keys.filter((k) => k !== key));
  };

  async function submit() {
    if (!recipe) return;
    const missing = missingFields(recipe.params, values);
    setShown(missing);
    if (missing.length) {
      document.getElementById(`${base}-${missing[0]}`)?.focus();
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const result = await window.zeno.features.createRecipe(recipe.id, values);
      if (result.ok) {
        props.onStart(result.path, result.prompt);
        return;
      }
      if (result.missing?.length) setShown(result.missing);
      else setError(tr("features.recipes.failed", { error: result.reason }));
    } catch (e) {
      setError(
        tr("features.recipes.failed", { error: e instanceof Error ? e.message : String(e) }),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && props.onClose()}>
      <DialogContent className="max-w-md gap-4 p-5" data-testid="recipe-dialog">
        <DialogHeader>
          <DialogTitle className="text-[16px] font-semibold">{recipe.title}</DialogTitle>
          <DialogDescription className="text-[13px] leading-relaxed">
            {recipe.description}
          </DialogDescription>
        </DialogHeader>
        <form
          className="recipe-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {recipe.params.map((p) => {
            const id = `${base}-${p.key}`;
            const errorId = `${id}-error`;
            const invalid = shown.includes(p.key);
            return (
              <div key={p.key} className="recipe-field" data-testid={`recipe-field-${p.key}`}>
                {p.inputType === "select" ? (
                  <>
                    <span className="recipe-label" id={`${id}-label`}>
                      {p.label}
                    </span>
                    <div
                      className="recipe-choices"
                      role="radiogroup"
                      aria-labelledby={`${id}-label`}
                    >
                      {p.options?.map((option) => (
                        <button
                          key={option}
                          type="button"
                          role="radio"
                          aria-checked={values[p.key] === option}
                          className="recipe-choice"
                          onClick={() => set(p.key, option)}
                        >
                          {option}
                        </button>
                      ))}
                    </div>
                  </>
                ) : p.inputType === "boolean" ? (
                  <div className="recipe-switch">
                    <label className="recipe-label" htmlFor={id}>
                      {p.label}
                    </label>
                    <Switch
                      id={id}
                      checked={values[p.key] === true}
                      onCheckedChange={(on) => set(p.key, on)}
                    />
                  </div>
                ) : (
                  <>
                    <label className="recipe-label" htmlFor={id}>
                      {p.label}
                      {p.required ? (
                        <span className="recipe-required">
                          {" "}
                          · {tr("features.recipes.requiredMark")}
                        </span>
                      ) : null}
                    </label>
                    <Input
                      id={id}
                      value={String(values[p.key] ?? "")}
                      placeholder={p.placeholder}
                      aria-required={p.required}
                      aria-invalid={invalid}
                      aria-describedby={invalid ? errorId : undefined}
                      maxLength={300}
                      onChange={(event) => set(p.key, event.target.value)}
                      className="h-9 text-[13px]"
                    />
                    {invalid ? (
                      <span className="recipe-error" id={errorId} role="alert">
                        {tr("features.recipes.required")}
                      </span>
                    ) : null}
                  </>
                )}
              </div>
            );
          })}
          {error ? (
            <p className="recipe-error" role="alert">
              {error}
            </p>
          ) : null}
          <p className="recipe-hint">{tr("features.recipes.hint")}</p>
          <DialogFooter className="gap-2 sm:justify-end">
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={props.onClose}>
              {tr("features.recipes.cancel")}
            </Button>
            <Button type="submit" size="sm" disabled={busy} data-testid="recipe-start">
              {tr(busy ? "features.recipes.busy" : "features.recipes.start")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
