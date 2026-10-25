/**
 * IPC `prsloy:support-report`: collect, scrub, zip to the desktop, show it in its folder.
 * Nothing leaves the machine.
 */
import { app, screen, shell } from "electron";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { arch, homedir, release, type, userInfo, version } from "node:os";
import { join } from "node:path";
import type { PrsloySupportReportResult } from "@zeno/contracts";
import type { PrsloyContext } from "../context.ts";
import { buildSupportReport, supportReportFileName } from "./report.ts";

export const SUPPORT_REPORT_IPC = "prsloy:support-report";

export type SupportReportDeps = {
  ctx: PrsloyContext;
  logDir: string;
  piVersion: () => string | undefined;
  appScale: () => unknown;
  runtimes: () => Record<string, unknown>;
};

function safeUserName(): string | undefined {
  try {
    return userInfo().username;
  } catch {
    return undefined;
  }
}

function targetDir(): string {
  for (const name of ["desktop", "downloads", "documents"] as const) {
    try {
      const dir = app.getPath(name);
      if (dir && existsSync(dir)) return dir;
    } catch {
      // try the next one
    }
  }
  const fallback = join(app.getPath("userData"), "reports");
  mkdirSync(fallback, { recursive: true });
  return fallback;
}

export function saveSupportReport(deps: SupportReportDeps): PrsloySupportReportResult {
  try {
    const now = new Date();
    const key = deps.ctx.keyStore.read();
    const { zip } = buildSupportReport({
      now,
      userDataPath: app.getPath("userData"),
      sessionsDir: deps.ctx.sessionDir,
      logDir: deps.logDir,
      crashDir: app.getPath("crashDumps"),
      versions: {
        app: app.getVersion(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        pi: deps.piVersion(),
        os: `${type()} ${release()} ${arch()}`,
        osVersion: (() => {
          try {
            return version();
          } catch {
            return undefined;
          }
        })(),
        locale: app.getLocale(),
        systemLocale: app.getSystemLocale(),
        displays: screen.getAllDisplays().map((d) => ({
          scaleFactor: d.scaleFactor,
          size: `${d.size.width}x${d.size.height}`,
        })),
        appScale: deps.appScale(),
        packaged: app.isPackaged,
      },
      runtimes: {
        git: deps.ctx.git.state(),
        shell: deps.ctx.shellSource ?? null,
        ...deps.runtimes(),
        designVenv: existsSync(join(app.getPath("userData"), "design", "venv")),
      },
      scrub: { secrets: key ? [key] : [], userName: safeUserName(), home: homedir() },
    });
    const name = supportReportFileName(now);
    const path = join(targetDir(), name);
    writeFileSync(path, zip);
    // Headless CI runners have no file manager: the reveal there kept the app from quitting.
    if (process.env.ZENO_ENABLE_TEST_COMMANDS !== "1") shell.showItemInFolder(path);
    console.log(`[prsloy] support report saved (${zip.length} bytes)`);
    return { ok: true, path, name };
  } catch (error) {
    console.warn("[prsloy] support report failed:", error);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
