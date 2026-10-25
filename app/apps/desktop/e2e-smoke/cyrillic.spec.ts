/**
 * Russian Windows reality: a user named «Иван Петров» with a project in `C:\Проекты\мой сайт`.
 *
 * CI installs PRSLOY a second time into the Cyrillic profile (`/D=…\Иван Петров\AppData\Local\
 * Programs\PRSLOY`) and runs this spec against that exe. The launch points USERPROFILE, APPDATA,
 * LOCALAPPDATA and TEMP into the profile and userData to `APPDATA\PRSLOY`, so runtime
 * extraction, the PortableGit unpack, the agent home and bash all work under Cyrillic paths
 * with a space.
 *
 * Env: SMOKE_CYRILLIC_PROFILE (default `C:\Users\Иван Петров`, or tmp on Linux),
 * SMOKE_CYRILLIC_WORKSPACE (default `C:\Проекты\мой сайт`).
 */
import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HARNESS_HEADER,
  beforeAllSmoke,
  bundledRuntimes,
  close,
  launch,
  runBashTurn,
  send,
  shot,
  startHost,
  writeMetrics,
  type Launched,
} from "./helpers.ts";

const isWindows = process.platform === "win32";
const NOTE = "заметка о сайте.txt";

async function cyrillicPaths(): Promise<{ profile: string; workspace: string }> {
  if (isWindows) {
    return {
      profile: process.env.SMOKE_CYRILLIC_PROFILE ?? "C:\\Users\\Иван Петров",
      workspace: process.env.SMOKE_CYRILLIC_WORKSPACE ?? "C:\\Проекты\\мой сайт",
    };
  }
  const base = await mkdtemp(join(tmpdir(), "prsloy-smoke-cyr-"));
  return {
    profile: process.env.SMOKE_CYRILLIC_PROFILE ?? join(base, "Иван Петров"),
    workspace: process.env.SMOKE_CYRILLIC_WORKSPACE ?? join(base, "Проекты", "мой сайт"),
  };
}

test.describe.configure({ mode: "serial" });

test.beforeAll(beforeAllSmoke);

test("Cyrillic profile + project: runtimes, Git, bash cd, python3 привет, Cyrillic file", async () => {
  const { profile, workspace } = await cyrillicPaths();
  // What a model types: cd into the project by its Windows path, Russian output from
  // python3, a file with a Cyrillic name and a space.
  const cdTarget = isWindows ? workspace : workspace.replaceAll("'", "'\\''");
  const command = [
    `cd '${cdTarget}'`,
    "pwd",
    `python3 -c "print('привет')"`,
    `printf 'тест\\n' > '${NOTE}'`,
    "ls",
    `cat '${NOTE}'`,
    "echo HOME=$HOME",
  ].join("; ");
  let launched: Launched | undefined;
  try {
    launched = await launch("cyrillic", { profile, workspace, bashCommand: command });
    const { page, userData } = launched;
    await writeMetrics({
      cyrillic: { profile, workspace, userData, firstWindowMs: launched.launchMs },
    });
    await shot(page, "20-cyrillic-window");

    const bundled = bundledRuntimes(userData);
    expect(bundled.node, `bundled node missing under ${userData}`).toBeTruthy();
    expect(bundled.python, `bundled python missing under ${userData}`).toBeTruthy();

    await startHost(page);
    await send(page, "Привет! Ответь одной фразой.");
    await expect
      .poll(async () => page.getByTestId("timeline").innerText(), { timeout: 30_000 })
      .toContain("Zeno fake model response");

    const bash = await runBashTurn(launched, "cyrillic", "привет");
    const report = `bash tool result:\n${bash.result}`;
    const notePath = join(workspace, NOTE);
    const note = existsSync(notePath) ? await readFile(notePath, "utf8") : null;
    await writeMetrics({
      cyrillicResult: {
        gitSetupStatus: launched.gitSetup.status ?? null,
        gitSetupMs: launched.gitSetup.ms ?? null,
        noteOnDisk: note,
      },
    });
    await shot(page, "21-cyrillic-bash");

    expect(bash.result, report).toMatch(HARNESS_HEADER);
    expect(bash.result, report).toMatch(/^привет$/m);
    expect(bash.result, report).toContain(NOTE);
    expect(bash.result, report).toMatch(/^тест$/m);
    expect(bash.result, report).toMatch(isWindows ? /\/c\/Проекты\/мой сайт/ : /Проекты\/мой сайт/);
    expect(note, `${notePath} on disk`).toBe("тест\n");
    if (isWindows) expect(launched.gitSetup.status, "PortableGit unpack").toBe("ready");
    expect(launched.pageErrors, launched.pageErrors.join("\n\n")).toEqual([]);
  } finally {
    if (launched) await shot(launched.page, "99-cyrillic-final");
    await close(launched);
  }
});
