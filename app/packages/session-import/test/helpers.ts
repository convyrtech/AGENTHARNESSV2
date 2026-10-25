import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SourceRoots } from "../src/paths.ts";

export const FIXTURES = fileURLToPath(new URL("./fixtures", import.meta.url));
export const WINDOWS_CWD = {
  claude: "C:\\Users\\Пётр\\Проекты\\сайт-пекарни",
  codex: "C:\\Users\\Пётр\\Проекты\\бот-заказов",
  pi: "C:\\Users\\Пётр\\Проекты\\заметки",
} as const;
export const CLAUDE_DIR = join(FIXTURES, "claude-code", "projects", "C--Users-----------------");
export const CLAUDE_BASIC = join(CLAUDE_DIR, "5f0c2a8e-1b7d-4c3e-9a61-0d2f8e4b7c10.jsonl");
export const CLAUDE_BRANCHES = join(CLAUDE_DIR, "7a1e9c44-2d3b-4f5a-8e6c-1b0d9f2a3c45.jsonl");
export const CLAUDE_CONTINUED = join(CLAUDE_DIR, "9b2f0d55-3e4c-4a6b-9f7d-2c1e0a3b4d56.jsonl");
export const CLAUDE_BROKEN = join(CLAUDE_DIR, "1c3a5e77-4f6d-4b8c-a0e9-3d2f1b4c5e67.jsonl");
export const CODEX_ID = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
export const CODEX_FIRST = join(
  FIXTURES,
  "codex/sessions/2026/10/01",
  `rollout-2026-10-01T10-00-00-${CODEX_ID}.jsonl`,
);
export const CODEX_RESUMED = join(
  FIXTURES,
  "codex/sessions/2026/10/02",
  `rollout-2026-10-02T09-00-00-${CODEX_ID}.jsonl`,
);
export const PI_DIR = join(FIXTURES, "pi", "sessions");
export const PI_FILE = join(
  PI_DIR,
  "--C--Users-Пётр-Проекты-заметки--",
  "2026-10-01T10-00-00-000Z_3e5c7a99-6b8f-4d0e-b2a1-5f4d3c6e7a89.jsonl",
);

const temporary: string[] = [];

export async function tempDir(prefix = "prsloy-import-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(dir);
  return dir;
}

export async function cleanTemp(): Promise<void> {
  await Promise.all(temporary.splice(0).map((d) => rm(d, { recursive: true, force: true })));
}

async function rewrite(dir: string, from: string, to: string): Promise<void> {
  const escapedFrom = JSON.stringify(from).slice(1, -1);
  const escapedTo = JSON.stringify(to).slice(1, -1);
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const path = join(entry.parentPath, entry.name);
    const text = await readFile(path, "utf8");
    if (text.includes(escapedFrom)) await writeFile(path, text.replaceAll(escapedFrom, escapedTo));
  }
}

/**
 * The fixtures copied into a fake home, with the Windows project folders pointed at real
 * folders on this machine (Cyrillic names kept), so a run can resolve them.
 */
export async function fakeMachine(): Promise<{
  root: string;
  home: string;
  roots: SourceRoots;
  projects: { claude: string; codex: string; pi: string };
  sessionDir: string;
  ledgerPath: string;
}> {
  const root = await tempDir();
  const home = join(root, "дом");
  const roots: SourceRoots = {
    claudeProjects: join(home, ".claude", "projects"),
    codexHome: join(home, ".codex"),
    piSessions: join(home, ".pi", "agent", "sessions"),
    opencodeData: join(home, ".local", "share", "opencode"),
    geminiDir: join(home, ".gemini"),
  };
  await cp(join(FIXTURES, "claude-code", "projects"), roots.claudeProjects, { recursive: true });
  await cp(join(FIXTURES, "codex"), roots.codexHome, { recursive: true });
  await cp(PI_DIR, roots.piSessions, { recursive: true });
  const projects = {
    claude: join(root, "Проекты", "сайт-пекарни"),
    codex: join(root, "Проекты", "бот-заказов"),
    pi: join(root, "Проекты", "заметки"),
  };
  for (const [key, path] of Object.entries(projects) as [keyof typeof projects, string][]) {
    await mkdir(path, { recursive: true });
    await rewrite(home, WINDOWS_CWD[key], path);
  }
  return {
    root,
    home,
    roots,
    projects,
    sessionDir: join(root, "prsloy", "sessions"),
    ledgerPath: join(root, "prsloy", "import-ledger.json"),
  };
}
