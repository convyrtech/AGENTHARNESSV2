/**
 * Aider chats: `<project>\.aider.chat.history.md`, one Markdown file per project folder with
 * every session appended (research/25 §2). Only project folders already known are looked in —
 * those other agents' chats point to — Aider keeps no list of its own.
 *
 *   # aider chat started at 2026-10-20 10:00:00     a session starts (local time)
 *   #### make a landing page                       the person (one line each, multi-line input repeats it)
 *   > Applied edit to index.html                   Aider's own output and commands
 *   anything else                                  the model's reply
 *
 * Each session becomes its own chat. SEARCH/REPLACE edit blocks in replies become notes
 * («• Edit: index.html»), not pages of code. One file holds many chats, so a chat's version for
 * the journal is its start time and length, not the file's hash.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { toolNote } from "../clean.ts";
import { pickTitle } from "../title.ts";
import {
  emptyDropped,
  type ChatCandidate,
  type ImportedChat,
  type ImportedTurn,
} from "../types.ts";
import { finishChat, pushTurn } from "./finish.ts";

export const AIDER_HISTORY = ".aider.chat.history.md";
/** A history file larger than this is not read whole. */
const MAX_HISTORY_BYTES = 64 * 1024 * 1024;
const SESSION_START = /^# aider chat started at (.+)$/u;

type AiderSection = { start: string; lines: string[] };

function sectionsOf(path: string): AiderSection[] {
  if (!existsSync(path) || statSync(path).size > MAX_HISTORY_BYTES) return [];
  const sections: AiderSection[] = [];
  for (const line of readFileSync(path, "utf8").split(/\r?\n/u)) {
    const start = SESSION_START.exec(line);
    if (start) sections.push({ start: start[1]!.trim(), lines: [] });
    else sections.at(-1)?.lines.push(line);
  }
  return sections;
}

function startTime(start: string): number | undefined {
  const t = Date.parse(start.replace(" ", "T"));
  return Number.isFinite(t) ? t : undefined;
}

/** «filename» + fenced SEARCH/REPLACE block → one note; other code stays. */
const EDIT_BLOCK = /(?:^|\n)([^\n`]+)\n```[^\n]*\n<<<<<<< SEARCH\n[\s\S]*?\n>>>>>>> REPLACE\n```/gu;

export function aiderReply(text: string, files: Set<string>): string {
  return text
    .replace(EDIT_BLOCK, (_whole, file: string) => {
      files.add(file.trim());
      return `\n${toolNote("Edit", { file_path: file.trim() })}\n`;
    })
    .replace(/\n+(• )/gu, "\n$1")
    .replace(/^(• [^\n]*)\n+/gmu, "$1\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function parseSection(section: AiderSection) {
  const turns: ImportedTurn[] = [];
  const files = new Set<string>();
  const dropped = emptyDropped();
  let user: string[] = [];
  let reply: string[] = [];
  const time = startTime(section.start);
  const flushUser = () => {
    if (user.length) pushTurn(turns, "user", user.join("\n"), time);
    user = [];
  };
  const flushReply = () => {
    const text = aiderReply(reply.join("\n"), files);
    if (text) pushTurn(turns, "assistant", text, time);
    reply = [];
  };
  let inFence = false;
  for (const line of section.lines) {
    // inside a code block every line is the reply's, even «>>>>>>> REPLACE»
    if (line.startsWith("```")) inFence = !inFence;
    if (inFence || line.startsWith("```")) {
      flushUser();
      reply.push(line);
      continue;
    }
    if (line.startsWith("#### ")) {
      flushReply();
      user.push(line.slice(5));
    } else if (line.startsWith(">")) {
      flushUser();
      const applied = /^> Applied edit to (.+)$/u.exec(line);
      if (applied) files.add(applied[1]!.trim());
      dropped.service += 1;
    } else {
      if (user.length && line.trim() === "") continue;
      flushUser();
      reply.push(line);
    }
  }
  flushUser();
  flushReply();
  return { turns, files, dropped, time };
}

/** The sessions of one project's history file. */
export function aiderCandidates(project: string): ChatCandidate[] {
  const path = join(project, AIDER_HISTORY);
  const candidates: ChatCandidate[] = [];
  for (const section of sectionsOf(path)) {
    const { turns, time } = parseSection(section);
    const first = turns.find((t) => t.role === "user");
    if (!first) continue;
    const length = section.lines.join("\n").length;
    const updatedAt = time ?? statSync(path).mtimeMs;
    candidates.push({
      tool: "aider",
      sourceId: `${project}#${section.start}`,
      sourcePath: path,
      cwd: project,
      title: pickTitle({ firstRequest: first.text }),
      updatedAt,
      size: length,
      mtimeMs: updatedAt,
      fingerprint: `aider:${section.start}:${length}`,
    });
  }
  return candidates;
}

export function readAiderChat(
  path: string,
  sourceId: string,
  cwd: string,
): ImportedChat | undefined {
  const start = sourceId.slice(sourceId.lastIndexOf("#") + 1);
  const section = sectionsOf(path).find((s) => s.start === start);
  if (!section) return undefined;
  const { turns, files, dropped, time } = parseSection(section);
  return finishChat({
    tool: "aider",
    sourceId,
    sourcePath: path,
    cwd,
    turns,
    titles: {},
    files,
    dropped,
    fallbackTime: time ?? statSync(path).mtimeMs,
  });
}
