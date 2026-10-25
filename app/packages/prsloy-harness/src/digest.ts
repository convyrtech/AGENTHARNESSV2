// S6 из research/18-memory-self-learning.md (§6.1 (a), §9.1): сводка «прошлый раз» пишется кодом, без LLM, на
// agent_settled. Что правили (по edit/write и по теневому git хода — видны и правки через bash), какое превью
// работало (реестр фоновых процессов), чем кончилась проверка проекта. Лежит в project.json рядом с решениями
// пользователя и попадает в раздел prsloy_memory со следующей сессии. ≤600 символов.
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFlags } from "./flags.ts";
import { type LearningEvent, onLearningEvent } from "./learning-log.ts";
import { MEMORY_LIMITS, type MemoryStore } from "./memory-store.ts";
import type { BackgroundProcess } from "./process-registry.ts";
import { scrubSecrets } from "./secret-scrub.ts";
import { detectProjectCheck } from "./stop-gate.ts";
import type { TurnChanges } from "./turn-changes.ts";

export interface DigestInput {
  date: Date;
  files: string[];
  servers: { command: string; ports: number[] }[];
  /** Проверка проекта: команда и итог; без проверки — undefined. */
  check?: { label: string; green: boolean } | undefined;
}

function listFiles(files: string[]): string {
  const names = [...new Set(files.map((f) => f.replace(/\\/g, "/")))];
  const shown = names.slice(0, 6).join(", ");
  return names.length > 6 ? `${shown} и ещё ${names.length - 6}` : shown;
}

/** Текст сводки. Пусто — писать нечего (ничего не правили и превью не было). */
export function buildDigest(input: DigestInput): string {
  if (!input.files.length && !input.servers.length) return "";
  const day = input.date.toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
  const parts = [`Прошлый раз (${day}):`];
  if (input.files.length) parts.push(`правили ${listFiles(input.files)}.`);
  if (input.servers.length) {
    const preview = input.servers
      .slice(0, 2)
      .map((s) => {
        const command = scrubSecrets(s.command).text.slice(0, 80);
        return s.ports.length ? `${command} (порт ${s.ports.join(", ")})` : command;
      })
      .join("; ");
    parts.push(`Превью: ${preview}.`);
  }
  parts.push(
    input.check
      ? `Проверка проекта (${input.check.label.slice(0, 60)}): ${input.check.green ? "зелёная" : "красная"}.`
      : "Проверки проекта нет.",
  );
  return parts.join(" ").slice(0, MEMORY_LIMITS.digestChars);
}

interface SessionDigest {
  files: Set<string>;
  check: boolean | undefined;
}

export interface DigestSources {
  store: MemoryStore;
  changes?: TurnChanges | undefined;
  servers?: (() => BackgroundProcess[]) | undefined;
  settingsPath?: string | undefined;
}

export function installDigest(pi: ExtensionAPI, sources: DigestSources): void {
  const sessions = new Map<string, SessionDigest>();
  const sessionOf = (ctx: ExtensionContext | undefined) => {
    try {
      return ctx?.sessionManager.getSessionId() ?? "";
    } catch {
      return "";
    }
  };
  const state = (session: string) => {
    let s = sessions.get(session);
    if (!s) {
      s = { files: new Set(), check: undefined };
      sessions.set(session, s);
    }
    return s;
  };

  pi.on("tool_result", (event, ctx) => {
    if ((event.toolName === "edit" || event.toolName === "write") && !event.isError) {
      const path = (event.input as { path?: unknown }).path;
      if (typeof path === "string") state(sessionOf(ctx)).files.add(path);
    }
    return undefined;
  });

  const unsubscribe = onLearningEvent((session: string, event: LearningEvent) => {
    if (event.kind === "gate.green") state(session).check = true;
    if (event.kind === "gate.red" || event.kind === "gate.gaveup") state(session).check = false;
  });
  pi.on("session_shutdown", () => {
    unsubscribe();
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!readFlags(sources.settingsPath).memory) return;
    const s = state(sessionOf(ctx));
    // Правки через bash (sed -i, генераторы) — по теневому git хода.
    for (const file of sources.changes?.takeLastDiff()?.files ?? []) s.files.add(file);
    const servers = (sources.servers?.() ?? [])
      .filter((p) => p.exitCode === undefined)
      .map((p) => ({ command: p.command, ports: p.ports }));
    const check = s.check === undefined ? undefined : detectProjectCheck(ctx.cwd);
    const text = buildDigest({
      date: new Date(),
      // Пути — относительно проекта, как их видит пользователь; абсолютные — по имени файла.
      files: [...s.files].map((f) => (f.startsWith("/") || /^[A-Za-z]:/.test(f) ? basename(f) : f)),
      servers,
      check: check && s.check !== undefined ? { label: check.label, green: s.check } : undefined,
    });
    if (text) sources.store.setDigest(ctx.cwd, text);
  });
}
