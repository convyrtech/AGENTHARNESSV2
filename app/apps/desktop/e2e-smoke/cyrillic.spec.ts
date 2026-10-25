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
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readZip } from "../src/main/prsloy/support/read-zip.ts";
import { GOOD_KEY, seedGateway, startGateway } from "./gateway.ts";
import {
  HARNESS_HEADER,
  beforeAllSmoke,
  findings,
  bundledRuntimes,
  close,
  FIRST_RUN_KEY,
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
const GIT_DIR = "новый проект";

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
    // A new project folder with a Cyrillic name: git works there (PortableGit unpacked by
    // the installer, post-install run by the app).
    `mkdir -p '${GIT_DIR}' && cd '${GIT_DIR}' && git init -q && git status --porcelain -b && echo GIT_INIT_OK`,
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
      "git init && git status in a new Cyrillic folder",
      bash.result.includes("GIT_INIT_OK") &&
        /^## (No commits yet on|Initial commit on) /m.test(bash.result) &&
        existsSync(join(workspace, GIT_DIR, ".git", "HEAD")),
      report,
    );
    ru.check(
      "file on disk with Cyrillic name",
      note === "тест\n",
      `${notePath}: ${JSON.stringify(note)}`,
    );
    if (isWindows) {
      // Ask the app: with Git unpacked by the installer the «ready» log line is printed at
      // startup, before this test reads stdout.
      const gitStatus = await page
        .evaluate(() => window.zeno.prsloy.getState())
        .then((state) => state.gitSetup.status)
        .catch((error: unknown) => `getState failed: ${String(error)}`);
      ru.check("PortableGit unpacked", gitStatus === "ready", String(gitStatus));
    }
    // Support report (stage 7): saved locally, the profile name never inside it.
    const saved = await page.evaluate(() => window.zeno.prsloy.saveSupportReport());
    expect(saved.ok, JSON.stringify(saved)).toBe(true);
    if (saved.ok) {
      const files = readZip(await readFile(saved.path));
      const all = Buffer.concat([...files.values()]);
      await writeMetrics({ supportReport: { name: saved.name, files: [...files.keys()] } });
      expect([...files.keys()]).toContain("report.json");
      for (const leak of ["Иван", "Петров"]) {
        expect(all.includes(Buffer.from(leak, "utf8")), `${leak} in the report`).toBe(false);
      }
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

/**
 * #22: chats from other agents on the first run, in the Cyrillic profile. A synthetic Claude
 * Code chat (never a real transcript) about the Cyrillic project sits in `<profile>\.claude`;
 * the product-mode first run offers it after the key, brings it over, and the folder step
 * offers its project first.
 */
test("Cyrillic profile: first run brings a Claude Code chat over", async () => {
  const { profile, workspace } = await cyrillicPaths();
  const sessionId = "4d2c6b1a-8e9f-4a7b-b3c5-6d1e2f3a4b5c";
  const chatDir = join(profile, ".claude", "projects", "C--Proekty-moy-sayt");
  await mkdir(chatDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  const line = (record: object) => JSON.stringify({ sessionId, cwd: workspace, ...record });
  await writeFile(
    join(chatDir, `${sessionId}.jsonl`),
    [
      line({
        type: "user",
        uuid: "u1",
        parentUuid: null,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "Сделай страницу «О нас» для сайта" },
      }),
      line({
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        timestamp: new Date().toISOString(),
        message: {
          id: "m1",
          role: "assistant",
          model: "claude-sonnet-4-5",
          content: [{ type: "text", text: "Сделал about.html." }],
        },
      }),
      JSON.stringify({ type: "custom-title", customTitle: "Страница «О нас»", sessionId }),
    ].join("\n") + "\n",
  );
  const gateway = await startGateway();
  let launched: Launched | undefined;
  try {
    launched = await launch("cyrillic-import", {
      profile,
      workspace,
      testMode: false,
      prepare: async (userData) => {
        await seedGateway(gateway.baseUrl)(userData);
        // the first test opened the workspace in this profile: start from no project again
        await rm(join(userData, "zeno-desktop.json"), { force: true });
        await rm(join(userData, "prsloy", "import-ledger.json"), { force: true });
      },
    });
    gateway.setUpstream(launched.fakeModel.baseUrl);
    const { page } = launched;
    await page.locator(`${FIRST_RUN_KEY} input`).fill(GOOD_KEY);
    await page.locator(`${FIRST_RUN_KEY} button[type="submit"]`).click();

    await expect(page.getByTestId("prsloy-first-run-import")).toBeVisible({ timeout: 60_000 });
    const claude = page.getByTestId("prsloy-import-tool-claude-code");
    await expect(claude).toContainText("1 чат в 1 проекте");
    await expect(claude.locator("input")).toBeChecked();
    await shot(page, "22-cyrillic-import");
    await page.getByTestId("prsloy-import-submit").click();
    await expect(page.getByTestId("prsloy-import-result")).toHaveText("Перенёс 1 чат", {
      timeout: 60_000,
    });
    await page.getByTestId("prsloy-import-next").click();
    // RC check (desktop/ui-rc): the search step shows once SEARCH_READY
    await page.getByTestId("first-run-search-skip").click({ timeout: 60_000 });

    await expect(page.getByTestId("prsloy-first-run-folder")).toBeVisible({ timeout: 60_000 });
    const first = page.getByTestId("prsloy-folder-recent").getByRole("button").first();
    await expect(first).toHaveAttribute("title", workspace);
    await first.click();
    await expect(page.getByTestId("zeno-app")).toBeVisible({ timeout: 60_000 });
    const card = page.getByTestId("project-card").filter({ hasText: "мой сайт" }).first();
    // the project chats were brought into starts open in the sidebar
    await expect(card).toHaveAttribute("data-expanded", "true", { timeout: 30_000 });
    await expect(page.getByText("Страница «О нас»").first()).toBeVisible({ timeout: 60_000 });
    await shot(page, "23-cyrillic-imported-chat");
  } finally {
    await close(launched);
    await gateway.stop();
  }
});
