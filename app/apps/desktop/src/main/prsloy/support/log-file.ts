/**
 * The main process (and, through it, the Agent Host: index.ts relays its stdout/stderr with
 * an `[agent-host:<id>]` prefix) logs to the console only. For the support report the
 * console is also copied to `userData/logs/main.log`; on start a log over `maxBytes` moves
 * to `main.1.log`, so at most two files are kept.
 *
 * Lines are written as they are: secrets are scrubbed when the report is built, not here
 * (the report scrubber knows the real key and the user name).
 */
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { format } from "node:util";

export const LOG_FILE = "main.log";
export const PREVIOUS_LOG_FILE = "main.1.log";

type ConsoleLike = Pick<Console, "log" | "info" | "warn" | "error">;

export function installLogFile(options: {
  dir: string;
  maxBytes?: number;
  target?: ConsoleLike;
  now?: () => Date;
}): { path: string; close(): void } {
  const target = options.target ?? console;
  const now = options.now ?? (() => new Date());
  mkdirSync(options.dir, { recursive: true });
  const path = join(options.dir, LOG_FILE);
  try {
    if (existsSync(path) && statSync(path).size > (options.maxBytes ?? 2 * 1024 * 1024)) {
      renameSync(path, join(options.dir, PREVIOUS_LOG_FILE));
    }
  } catch {
    // keep appending to the old file
  }
  const stream = createWriteStream(path, { flags: "a" });
  stream.on("error", () => undefined); // a full disk must not break logging to the console
  stream.write(`\n=== ${now().toISOString()} start pid ${process.pid}\n`);
  for (const level of ["log", "info", "warn", "error"] as const) {
    const original = target[level].bind(target);
    target[level] = (...args: unknown[]) => {
      original(...args);
      try {
        const tag = level === "log" || level === "info" ? "" : `${level.toUpperCase()} `;
        stream.write(`${now().toISOString()} ${tag}${format(...args)}\n`);
      } catch {
        // ignore
      }
    };
  }
  return { path, close: () => stream.end() };
}
