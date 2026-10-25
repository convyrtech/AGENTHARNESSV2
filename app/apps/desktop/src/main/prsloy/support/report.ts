/**
 * «Сохранить отчёт для поддержки»: one zip the user hands to whoever they choose. Nothing
 * is sent anywhere by the app.
 *
 *   report.json        versions, runtimes, the last turns (metadata only), notes
 *   logs/main.log      last lines of the main + Agent Host log
 *   logs/updater.log   the auto-update lines of that log
 *   settings/*.json    desktop prefs, PRSLOY state, pi settings and models (keyless)
 *   crash/*.dmp        the newest local crash dumps (Crashpad, never uploaded)
 *
 * Every text entry goes through scrubReportText. Crash dumps are binary: one that contains
 * the key or a key-shaped string is left out (noted in report.json) rather than shipped.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { zipFiles } from "../../design/zip.ts";
import { LOG_FILE, PREVIOUS_LOG_FILE } from "./log-file.ts";
import { scrubReportText, type ScrubContext } from "./scrub.ts";
import { lastTurns } from "./turns.ts";

export type SupportReportInput = {
  now: Date;
  versions: Record<string, unknown>;
  runtimes: Record<string, unknown>;
  userDataPath: string;
  sessionsDir: string;
  logDir: string;
  crashDir?: string;
  logLines?: number;
  scrub: ScrubContext;
};

export function supportReportFileName(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `PRSLOY-отчёт-${date}-${pad(now.getHours())}${pad(now.getMinutes())}.zip`;
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function tailLines(text: string, count: number): string {
  const lines = text.split("\n");
  return lines.slice(Math.max(0, lines.length - count)).join("\n");
}

const SETTINGS: [string, string][] = [
  ["settings/desktop-prefs.json", "zeno-desktop.json"],
  ["settings/prsloy-state.json", join("prsloy", "state.json")],
  ["settings/pi-settings.json", join("agent", "settings.json")],
  ["settings/pi-models.json", join("agent", "models.json")],
];

/** A binary dump may hold the key in memory: ASCII or UTF-16. */
function dumpLeaks(data: Buffer, secrets: string[]): boolean {
  const latin = data.toString("latin1");
  if (/sk-[A-Za-z0-9_-]{16,}/u.test(latin)) return true;
  return secrets
    .filter((s) => s.length >= 6)
    .some((s) => data.includes(Buffer.from(s, "utf8")) || data.includes(Buffer.from(s, "utf16le")));
}

function crashDumps(dir: string | undefined): string[] {
  if (!dir || !existsSync(dir)) return [];
  const found: { path: string; mtime: number }[] = [];
  const visit = (d: string, depth: number) => {
    for (const name of (() => {
      try {
        return readdirSync(d);
      } catch {
        return [];
      }
    })()) {
      const path = join(d, name);
      try {
        const stat = statSync(path);
        if (stat.isDirectory() && depth > 0) visit(path, depth - 1);
        else if (name.endsWith(".dmp") && stat.size <= 10 * 1024 * 1024) {
          found.push({ path, mtime: stat.mtimeMs });
        }
      } catch {
        // gone meanwhile
      }
    }
  };
  visit(dir, 2);
  return found
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 3)
    .map((f) => f.path);
}

export function buildSupportReport(input: SupportReportInput): {
  zip: Buffer;
  entries: string[];
} {
  const scrub = (text: string) => scrubReportText(text, input.scrub);
  const entries: { name: string; data: Buffer }[] = [];
  const addText = (name: string, text: string) =>
    entries.push({ name, data: Buffer.from(scrub(text), "utf8") });
  const notes: string[] = [];

  const log = [
    readText(join(input.logDir, PREVIOUS_LOG_FILE)) ?? "",
    readText(join(input.logDir, LOG_FILE)) ?? "",
  ].join("\n");
  if (log.trim()) {
    addText("logs/main.log", tailLines(log, input.logLines ?? 3000));
    const updater = log
      .split("\n")
      .filter((line) => /update|updater|electron-updater/iu.test(line))
      .slice(-500)
      .join("\n");
    addText("logs/updater.log", updater || "(записей обновления нет)\n");
  } else {
    notes.push("Лог-файла нет (приложение ещё не запускалось с этой версией).");
  }

  for (const [name, rel] of SETTINGS) {
    const text = readText(join(input.userDataPath, rel));
    if (text !== undefined) addText(name, text);
  }

  for (const dump of crashDumps(input.crashDir)) {
    const data = readFileSync(dump);
    const name = `crash/${dump.split(/[\\/]/u).pop()}`;
    if (dumpLeaks(data, input.scrub.secrets)) {
      notes.push(`${name} не включён: в нём найдена строка, похожая на ключ.`);
      continue;
    }
    entries.push({ name, data });
  }

  const report = {
    createdAt: input.now.toISOString(),
    versions: input.versions,
    runtimes: input.runtimes,
    lastTurns: lastTurns(input.sessionsDir),
    files: entries.map((e) => e.name),
    notes,
  };
  addText("report.json", `${JSON.stringify(report, null, 2)}\n`);
  entries.unshift(entries.pop()!);
  return { zip: zipFiles(entries), entries: entries.map((e) => e.name) };
}
