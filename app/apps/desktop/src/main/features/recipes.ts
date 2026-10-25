/**
 * «Рецепты» (research/19 §2.1 + §2.3): five offline starters in the app — a business card,
 * a landing page, a Telegram bot, an Excel script, a simple game. A recipe is a Pi prompt
 * template (`recipe.md`: frontmatter + body) with our own `params:` for a small form, by
 * the idea of goose recipes (key, input_type string/select/boolean, requirement, default,
 * options; Apache-2.0, no code taken). Its `files/` are the starter laid into a new project.
 * Everything ships inside main.mjs: nothing is downloaded.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RecipeInfo, RecipeParam } from "@zeno/contracts";
import { parse } from "yaml";
import { safeName, withSuffix } from "./safe-name.ts";

type Recipe = RecipeInfo & {
  order: number;
  folder: string;
  prompt: string;
  files: { path: string; content: string }[];
};

const SOURCES = import.meta.glob("./recipes/**/*", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const MAX_VALUE = 300;

function frontmatter(text: string): { meta: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u.exec(text);
  if (!match) return { meta: {}, body: text };
  let meta: unknown;
  try {
    meta = parse(match[1] ?? "");
  } catch {
    meta = undefined;
  }
  return {
    meta: meta && typeof meta === "object" ? (meta as Record<string, unknown>) : {},
    body: (match[2] ?? "").trim(),
  };
}

function param(raw: unknown): RecipeParam | undefined {
  const p = raw as Record<string, unknown> | null;
  if (!p || typeof p.key !== "string" || typeof p.label !== "string") return undefined;
  const type = p.input_type;
  if (type !== "string" && type !== "select" && type !== "boolean") return undefined;
  const options = Array.isArray(p.options) ? p.options.map(String) : undefined;
  if (type === "select" && !options?.length) return undefined;
  return {
    key: p.key,
    label: p.label,
    inputType: type,
    required: p.requirement === "required",
    ...(p.default !== undefined ? { default: p.default as string | boolean } : {}),
    ...(options ? { options } : {}),
    ...(typeof p.placeholder === "string" ? { placeholder: p.placeholder } : {}),
  };
}

/** `dot.gitignore` in the bundle is `.gitignore` in the project (the bundler skips dotfiles). */
function projectPath(rel: string): string {
  return rel
    .split("/")
    .map((part) => (part.startsWith("dot.") ? `.${part.slice(4)}` : part))
    .join("/");
}

export function loadRecipes(sources: Record<string, string> = SOURCES): Recipe[] {
  const byId = new Map<string, Recipe>();
  for (const [key, text] of Object.entries(sources)) {
    const m = /^\.\/recipes\/([a-z0-9-]+)\/recipe\.md$/u.exec(key);
    if (!m?.[1]) continue;
    const { meta, body } = frontmatter(text);
    const params = Array.isArray(meta.params) ? meta.params.map(param) : [];
    if (params.some((p) => !p) || typeof meta.title !== "string" || !body) continue;
    byId.set(m[1], {
      id: m[1],
      title: meta.title,
      description: typeof meta.description === "string" ? meta.description : "",
      icon: typeof meta.icon === "string" ? meta.icon : "",
      params: params as RecipeParam[],
      order: typeof meta.order === "number" ? meta.order : 99,
      folder: typeof meta.folder === "string" ? meta.folder : meta.title,
      // Source lines are wrapped for reading; the request keeps only the paragraph breaks.
      prompt: body.replace(/([^\n])\n(?!\n)/gu, "$1 "),
      files: [],
    });
  }
  for (const [key, content] of Object.entries(sources)) {
    const m = /^\.\/recipes\/([a-z0-9-]+)\/files\/(.+)$/u.exec(key);
    const recipe = m?.[1] ? byId.get(m[1]) : undefined;
    if (recipe && m?.[2]) recipe.files.push({ path: projectPath(m[2]), content });
  }
  return [...byId.values()].sort((a, b) => a.order - b.order);
}

export function recipeInfos(recipes = loadRecipes()): RecipeInfo[] {
  return recipes.map(({ id, title, description, icon, params }) => ({
    id,
    title,
    description,
    icon,
    params,
  }));
}

/** One line, no template braces, at most 300 characters. */
function clean(value: string): string {
  return value
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\{\{|\}\}/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_VALUE);
}

export type FilledPrompt = { ok: true; prompt: string } | { ok: false; missing: string[] };

/** The request from the form: every `{{key}}` filled; a select keeps to its options. */
export function fillPrompt(recipe: Recipe, raw: unknown): FilledPrompt {
  const values = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const filled: Record<string, string> = {};
  const missing: string[] = [];
  for (const p of recipe.params) {
    const given = values[p.key];
    let value: string;
    if (p.inputType === "boolean") {
      const on = typeof given === "boolean" ? given : p.default === true;
      value = on ? "да" : "нет";
    } else if (p.inputType === "select") {
      const text = typeof given === "string" ? given : "";
      value = p.options?.includes(text) ? text : String(p.default ?? p.options?.[0] ?? "");
    } else {
      value = clean(typeof given === "string" ? given : "") || clean(String(p.default ?? ""));
    }
    if (p.required && !value) missing.push(p.key);
    filled[p.key] = value || "на твой выбор";
  }
  if (missing.length) return { ok: false, missing };
  return {
    ok: true,
    prompt: recipe.prompt.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/gu, (all, key: string) =>
      key in filled ? (filled[key] ?? "") : all,
    ),
  };
}

/**
 * `Визитка`, `Визитка 2`, …: a new folder under `root`, never an existing one; the name is
 * one Windows accepts (`safe-name.ts`).
 */
export function uniqueFolder(root: string, name: string): string {
  const safe = safeName(name, { fallback: "Проект" });
  let path = join(root, safe);
  for (let n = 2; existsSync(path); n++) path = join(root, withSuffix(safe, n));
  return path;
}

/** Lays the starter into a new folder and returns it with the filled request. */
export function createRecipeProject(
  recipe: Recipe,
  values: unknown,
  root: string,
): { ok: true; path: string; prompt: string } | { ok: false; missing: string[] } {
  const filled = fillPrompt(recipe, values);
  if (!filled.ok) return filled;
  const path = uniqueFolder(root, recipe.folder);
  mkdirSync(path, { recursive: true });
  for (const file of recipe.files) {
    const target = join(path, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
  }
  return { ok: true, path, prompt: filled.prompt };
}
