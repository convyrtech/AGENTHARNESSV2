// Оффлайн-улучшатель (#33): «дерево обвязки», которое редактор может править, — только данные:
//   lessons.json             ← lessons/code.json пакета
//   skills/<name>/SKILL.md   ← skills/ пакета
//   model-delta.md           ← добавка промпта модели (MODEL_DELTAS в code-prompt.ts — код, переносит человек)
// Код, инструменты, хуки и проверки харнесса редактор не трогает: такое предложение — абзацем в заметках человеку.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { modelDelta } from "../code-prompt.ts";
import { LESSONS_MAX, LESSONS_MAX_CHARS, type Lesson } from "../lessons.ts";
import { threatLine, treeThreats } from "../skill-threats.ts";
import { skillFilesFromDir } from "../skills.ts";
import { assertTreeHasNoGraderVerdicts } from "./leaks.ts";

export type HarnessTree = Record<string, string>;

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Предел добавки промпта модели: она идёт в каждый прогон. */
export const DELTA_MAX_CHARS = 1500;
export const SKILL_DESCRIPTION_MAX = 300;
export const SKILL_BODY_MAX = 8000;
export const LESSON_TEXT_MAX = 400;

/**
 * lessons.json, model-delta.md и файлы навыков (SKILL.md и его материалы: шаблоны, примеры) — плоско, без подпапок:
 * так навыки раскладывает materializeSkills.
 */
const ALLOWED =
  /^(?:lessons\.json|model-delta\.md|skills\/[a-z0-9][a-z0-9-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)$/;

/** Обвязка, с которой улучшатель начинает: то, что сейчас едет в приложении, для этой модели. */
export function baseTree(model: string): HarnessTree {
  const tree: HarnessTree = {
    "lessons.json": readFileSync(join(PKG, "lessons", "code.json"), "utf8"),
    "model-delta.md": modelDelta(model.split("/").pop()) ?? "",
  };
  for (const [name, files] of Object.entries(skillFilesFromDir(join(PKG, "skills")))) {
    for (const [file, text] of Object.entries(files)) tree[`skills/${name}/${file}`] = text;
  }
  return tree;
}

export function writeTree(dir: string, tree: HarnessTree): void {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  for (const [path, text] of Object.entries(tree)) {
    const p = join(dir, ...path.split("/"));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
}

/** Всё, что лежит в папке (включая то, чего быть не должно, — валидатор это увидит). */
export function readTree(dir: string): HarnessTree {
  const tree: HarnessTree = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else tree[relative(dir, p).split(sep).join("/")] = readFileSync(p, "utf8");
    }
  };
  if (existsSync(dir)) walk(dir);
  return tree;
}

function frontMatter(md: string): Record<string, string> | undefined {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(md);
  if (!m) return undefined;
  const out: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]!] = kv[2]!.replace(/^["']|["']$/g, "").trim();
  }
  return out;
}

/** Ошибки дерева (пусто — годится). Валидатор улучшателя: одна попытка исправить, потом откат к базе. */
export function validateTree(tree: HarnessTree): string[] {
  const errors: string[] = [];
  for (const path of Object.keys(tree)) {
    if (!ALLOWED.test(path))
      errors.push(
        `${path}: этот файл менять нельзя (только lessons.json, model-delta.md, skills/<name>/…)`,
      );
  }
  if (!("lessons.json" in tree)) errors.push("lessons.json: файл удалён");
  else {
    try {
      const raw = JSON.parse(tree["lessons.json"]!) as { lessons?: unknown };
      if (!Array.isArray(raw.lessons)) errors.push("lessons.json: нет массива lessons");
      else {
        const lessons = raw.lessons as Partial<Lesson>[];
        const ids = new Set<string>();
        lessons.forEach((l, i) => {
          const at = `lessons.json #${i}${l?.id ? ` (${l.id})` : ""}`;
          if (typeof l?.id !== "string" || !l.id) errors.push(`${at}: нет id`);
          else if (ids.has(l.id)) errors.push(`${at}: повтор id`);
          else ids.add(l.id);
          if (typeof l?.text !== "string" || !l.text.trim()) errors.push(`${at}: нет text`);
          else if (l.text.length > LESSON_TEXT_MAX)
            errors.push(`${at}: text длиннее ${LESSON_TEXT_MAX}`);
          if (l?.mode !== "always" && l?.mode !== "on-event")
            errors.push(`${at}: mode — always или on-event`);
          if (l?.mode === "on-event" && !l.trigger?.kind)
            errors.push(`${at}: у on-event нужен trigger.kind`);
          if (!Array.isArray(l?.models) || l.models.length === 0)
            errors.push(`${at}: нужен models`);
          if (!["candidate", "trial", "active", "retired"].includes(String(l?.status)))
            errors.push(`${at}: status`);
        });
        const always = lessons.filter(
          (l) => l.mode === "always" && l.status === "active" && !l.delivery,
        );
        const chars = always.reduce((n, l) => n + (l.text?.length ?? 0), 0);
        if (always.length > LESSONS_MAX)
          errors.push(`lessons.json: постоянных уроков ${always.length} > ${LESSONS_MAX}`);
        if (chars > LESSONS_MAX_CHARS)
          errors.push(`lessons.json: постоянные уроки ${chars} символов > ${LESSONS_MAX_CHARS}`);
      }
    } catch (e) {
      errors.push(`lessons.json: не JSON (${(e as Error).message})`);
    }
  }
  if ((tree["model-delta.md"] ?? "").length > DELTA_MAX_CHARS) {
    errors.push(`model-delta.md: длиннее ${DELTA_MAX_CHARS} символов (идёт в каждый прогон)`);
  }
  const skills = new Set(
    Object.keys(tree)
      .filter((p) => p.startsWith("skills/"))
      .map((p) => p.split("/")[1]!),
  );
  for (const name of skills) {
    const md = tree[`skills/${name}/SKILL.md`];
    if (md === undefined) {
      errors.push(`skills/${name}: нет SKILL.md`);
      continue;
    }
    const fm = frontMatter(md);
    if (!fm) errors.push(`skills/${name}/SKILL.md: нет заголовка --- name / description ---`);
    else {
      if (fm.name !== name) errors.push(`skills/${name}/SKILL.md: name должно быть «${name}»`);
      if (!fm.description)
        errors.push(`skills/${name}/SKILL.md: пустой description (это триггер навыка)`);
      else if (fm.description.length > SKILL_DESCRIPTION_MAX)
        errors.push(`skills/${name}/SKILL.md: description длиннее ${SKILL_DESCRIPTION_MAX}`);
    }
    if (md.length > SKILL_BODY_MAX)
      errors.push(`skills/${name}/SKILL.md: длиннее ${SKILL_BODY_MAX} символов`);
  }
  // Безопасность (как сканер навыков в CI, по категориям SkillSpector): предложенный навык, урок или добавка
  // промпта с инъекцией, утечкой ключей или скрытым текстом не принимается.
  const surface = Object.fromEntries(
    Object.entries(tree).filter(
      ([p]) => p.startsWith("skills/") || p === "lessons.json" || p === "model-delta.md",
    ),
  );
  for (const t of treeThreats(surface)) errors.push(`небезопасно: ${threatLine(t)}`);
  try {
    assertTreeHasNoGraderVerdicts(tree);
  } catch (e) {
    errors.push((e as Error).message);
  }
  return errors;
}

/** Опции стенда для пробы дерева (bench --lessons-file / --skills-dir / --delta-file, но в памяти). */
export function benchOptionsFor(tree: HarnessTree, scratch: string) {
  mkdirSync(scratch, { recursive: true });
  const lessonsFile = join(scratch, "lessons.json");
  writeFileSync(lessonsFile, tree["lessons.json"] ?? '{"lessons":[]}');
  const skillFiles: Record<string, Record<string, string>> = {};
  for (const [path, text] of Object.entries(tree)) {
    const m = /^skills\/([^/]+)\/(.+)$/.exec(path);
    if (m) (skillFiles[m[1]!] ??= {})[m[2]!] = text;
  }
  return { lessonsFile, skillFiles, deltaText: (tree["model-delta.md"] ?? "").trim() };
}

export interface TreeChange {
  path: string;
  kind: "added" | "removed" | "changed";
}

export function diffTrees(base: HarnessTree, next: HarnessTree): TreeChange[] {
  const out: TreeChange[] = [];
  for (const path of new Set([...Object.keys(base), ...Object.keys(next)])) {
    if (!(path in next)) out.push({ path, kind: "removed" });
    else if (!(path in base)) out.push({ path, kind: "added" });
    else if (base[path] !== next[path]) out.push({ path, kind: "changed" });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
