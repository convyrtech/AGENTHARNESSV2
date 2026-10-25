// Курированные навыки «Кода» (S9, research/18): ≤12 своих рецептов под типичные задачи казуала, у каждого ≤3 файла,
// описание ≤200 символов. Механизм — скиллы Pi: имя, описание и путь — в системном промпте, тело модель читает
// сама, когда задача подходит. Навыки едут в бандле строками (src/skills-bundle.ts) и на resources_discover
// раскладываются в `$PI_CODING_AGENT_DIR/prsloy-skills/<версия>/`. Флаг "skills" (по умолчанию выкл.).
// Учёт для замера: `skill.loaded` — модель прочитала SKILL.md (или файл навыка), `skill.used` — после этого ход
// закончился зелёным.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFlags } from "./flags.ts";
import { onLearningEvent, recordEvent } from "./learning-log.ts";
import type { ResolvedOptions } from "./options.ts";
import { SKILL_FILES } from "./skills-bundle.ts";

export const SKILLS_MAX = 12;
export const SKILL_FILES_MAX = 3;
export const SKILL_DESCRIPTION_MAX = 200;

/** Версия комплекта: другая папка на каждое изменение — старые файлы не мешают, кэш промпта стабилен. */
export function skillsVersion(files: Record<string, Record<string, string>> = SKILL_FILES): string {
  return createHash("sha256").update(JSON.stringify(files)).digest("hex").slice(0, 12);
}

export function skillsRoot(base?: string): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  return base ?? join(agentDir || tmpdir(), "prsloy-skills");
}

/** Разложить навыки на диск (только недостающие или изменённые файлы). Возвращает папку комплекта. */
export function materializeSkills(base?: string, files = SKILL_FILES): string {
  const dir = join(skillsRoot(base), skillsVersion(files));
  for (const [name, entries] of Object.entries(files)) {
    const skillDir = join(dir, name);
    mkdirSync(skillDir, { recursive: true });
    for (const [file, text] of Object.entries(entries)) {
      const path = join(skillDir, file);
      if (existsSync(path) && readFileSync(path, "utf8") === text) continue;
      writeFileSync(path, text);
    }
  }
  return dir;
}

/** Какой навык читает вызов read (путь внутри комплекта) — или undefined. */
export function skillOfPath(dir: string, path: string, cwd: string): string | undefined {
  const rel = relative(resolve(dir), resolve(cwd, path));
  if (!rel || rel.startsWith("..") || resolve(rel) === rel) return undefined;
  const name = rel.split(sep)[0]!;
  return name in SKILL_FILES ? name : undefined;
}

function sessionOf(ctx: ExtensionContext): string {
  try {
    return ctx.sessionManager.getSessionId() ?? "";
  } catch {
    return "";
  }
}

export interface SkillsOptions {
  /** Куда раскладывать (по умолчанию `$PI_CODING_AGENT_DIR/prsloy-skills`). */
  dir?: string | undefined;
}

export function installSkills(
  pi: ExtensionAPI,
  opts: ResolvedOptions,
  options: SkillsOptions = {},
): void {
  if (opts.profile !== "code") return;
  let dir: string | undefined;
  /** Навыки, прочитанные в текущем ходе, по сессиям. */
  const loaded = new Map<string, { names: Set<string>; ctx: ExtensionContext }>();

  pi.on("resources_discover", () => {
    // Флаг читается при старте сессии: список навыков в промпте не меняется посреди сеанса (кэш).
    if (!readFlags(opts.settingsPath).skills) return {};
    try {
      dir = materializeSkills(options.dir);
    } catch {
      return {};
    }
    return { skillPaths: [dir] };
  });

  pi.on("tool_call", (event, ctx) => {
    if (!dir || event.toolName !== "read") return undefined;
    const path = (event.input as { path?: unknown }).path;
    if (typeof path !== "string") return undefined;
    const name = skillOfPath(dir, path, ctx.cwd);
    if (!name) return undefined;
    const session = sessionOf(ctx);
    const turn = loaded.get(session) ?? { names: new Set<string>(), ctx };
    if (!turn.names.has(name))
      recordEvent(ctx, { kind: "skill.loaded", tool: "read", sig: `skill:${name}` });
    turn.names.add(name);
    loaded.set(session, turn);
    return undefined;
  });

  // Итог хода приходит событием журнала (learning-log.ts): зелёный ход после чтения навыка — «использован».
  onLearningEvent((session, event) => {
    if (event.kind !== "turn.end") return;
    const turn = loaded.get(session);
    if (!turn) return;
    loaded.delete(session);
    if (event.outcome !== "green") return;
    for (const name of turn.names)
      recordEvent(turn.ctx, { kind: "skill.used", sig: `skill:${name}` });
  });
}
