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
 * SMOKE_CYRILLIC_WORKSPACE (default `C:\Проекты\мой сайт`). Checks are findings
 * (metrics.json → findings.cyrillic) that fail the test only with SMOKE_STRICT_RU=1, so open
 * bugs stay visible without blocking releases; the app must still start and answer.
 */
import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HARNESS_HEADER,
  beforeAllSmoke,
  findings,
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

    const ru = findings("cyrillic", process.env.SMOKE_STRICT_RU === "1");

    await startHost(page);
    await send(page, "Привет! Ответь одной фразой.");
    // Window first: Node/Python unpack in the background; main logs `runtimes` when that
    // ends (ready or failed).
    const timings = launched.timings;
    await expect.poll(() => timings.runtimes !== undefined, { timeout: 300_000 }).toBe(true);
    const bundled = bundledRuntimes(userData);
    ru.check(
      "bundled node extracted",
      Boolean(bundled.node),
      `nothing under ${userData}\\runtimes`,
    );
    ru.check(
      "bundled python extracted",
      Boolean(bundled.python),
      `nothing under ${userData}\\runtimes`,
    );
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

    // The app itself must work: a broken tool result is a finding, a missing one a failure.
    expect(bash.result, report).toMatch(HARNESS_HEADER);
    ru.check(
      "bash cd into the project",
      isWindows
        ? /\/c\/Проекты\/мой сайт/.test(bash.result)
        : /Проекты\/мой сайт/.test(bash.result),
      report,
    );
    ru.check("python3 prints привет", /^привет$/m.test(bash.result), report);
    ru.check("Cyrillic file name in ls", bash.result.includes(NOTE), report);
    ru.check("cat reads тест", /^тест$/m.test(bash.result), report);
    ru.check(
      "file on disk with Cyrillic name",
      note === "тест\n",
      `${notePath}: ${JSON.stringify(note)}`,
    );
    if (isWindows) {
      ru.check(
        "PortableGit unpacked",
        launched.gitSetup.status === "ready",
        String(launched.gitSetup.status),
      );
    }
    ru.check(
      "no renderer errors",
      launched.pageErrors.length === 0,
      launched.pageErrors.join("\n\n"),
    );
    await ru.finish();
  } finally {
    if (launched) await shot(launched.page, "99-cyrillic-final");
    await close(launched);
  }
});
