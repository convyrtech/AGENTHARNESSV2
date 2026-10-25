/**
 * Installed-app smoke test (CI: `.github/workflows/desktop-windows.yml` → smoke job).
 *
 * Launches an already-installed PRSLOY.exe (`PRSLOY_EXE`) — not the dev bundle — with
 * the same fake OpenAI-compatible model the e2e suite uses (see helpers.ts).
 *
 * Checks: main window, first-run runtime extraction, Agent Host ready, one reply,
 * one bash tool call, the «Дизайн» tab. A second launch hides Git for Windows (clean machine)
 * and requires the bundled PortableGit bash to run bash syntax, coreutils and git
 * (strict when SMOKE_STRICT_CLEAN_BASH=1, which CI sets; otherwise report only).
 *
 * Output (SMOKE_OUT, default ./smoke-out): screenshots, *-main.log, *-renderer.log,
 * metrics.json, bash-*.json.
 */
import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BASH_COMMAND,
  HARNESS_HEADER,
  MARKER,
  beforeAllSmoke,
  bundledRuntimes,
  findings,
  close,
  launch,
  listFiles,
  outDir,
  runBashTurn,
  send,
  shot,
  startHost,
  writeMetrics,
  type Launched,
} from "./helpers.ts";

const strictCleanBash = process.env.SMOKE_STRICT_CLEAN_BASH === "1";

test.describe.configure({ mode: "serial" });

test.beforeAll(beforeAllSmoke);

test("installed app: window, runtimes, host, reply, bash tool", async () => {
  let launched: Launched | undefined;
  try {
    launched = await launch("runner");
    const { page, userData } = launched;
    await writeMetrics({ firstWindowMs: launched.launchMs, bootstrapReadyMs: launched.readyMs });
    await shot(page, "01-window");

    // First-run extraction: Resources/runtimes/archives → userData/runtimes.
    const runtimes = join(userData, "runtimes");
    const files = listFiles(runtimes, 2).map((p) => p.slice(runtimes.length + 1));
    await writeFile(join(outDir, "runtimes-tree.txt"), files.join("\n"));
    const bundled = bundledRuntimes(userData);
    await writeMetrics({
      bundledNode: bundled.node ?? null,
      bundledPython: bundled.python ?? null,
    });
    expect(bundled.node, `bundled node missing under ${runtimes}`).toBeTruthy();
    expect(bundled.python, `bundled python missing under ${runtimes}`).toBeTruthy();

    const hostT0 = Date.now();
    await startHost(page);
    await writeMetrics({ hostReadyMs: Date.now() - hostT0 });
    await shot(page, "02-host-ready");

    await send(page, "Привет! Ответь одной фразой.");
    await expect
      .poll(async () => page.getByTestId("timeline").innerText(), { timeout: 30_000 })
      .toContain("Zeno fake model response");
    await shot(page, "03-reply");

    const bash = await runBashTurn(launched, "runner");
    await writeMetrics({
      gitSetupStatus: launched.gitSetup.status ?? null,
      gitSetupMs: launched.gitSetup.ms ?? null,
    });
    await expect
      .poll(async () => page.getByTestId("timeline").innerText(), { timeout: 30_000 })
      .toContain("Tool result received");
    expect(bash.result, `bash tool result:\n${bash.result}`).toContain(MARKER);
    expect(bash.result, `bash tool result:\n${bash.result}`).toMatch(HARNESS_HEADER);

    // «Дизайн» tab must open into a calm state, never crash. Without the design bundle (CI has
    // no token for the private pipeline repo) that is `design-unavailable`; with it, setup/key/empty.
    await page.getByTestId("nav-design").click();
    const designState = page.locator(
      [
        '[data-testid="design-unavailable"]',
        '[data-testid="design-setup"]',
        '[data-testid="design-needs-key"]',
        '[data-testid="design-empty"]',
      ].join(", "),
    );
    await expect(designState.first()).toBeVisible({ timeout: 30_000 });
    const states = await designState.evaluateAll((els) =>
      els.map(
        (el) =>
          `${el.getAttribute("data-testid")}${el.getAttribute("data-phase") ? `:${el.getAttribute("data-phase")}` : ""}`,
      ),
    );
    await writeMetrics({ designStates: states });
    await shot(page, "04-design");
    expect(launched.pageErrors, launched.pageErrors.join("\n\n")).toEqual([]);
  } finally {
    if (launched) await shot(launched.page, "99-runner-final");
    await close(launched);
  }
});

// What a casual user's agent runs first: bash syntax, coreutils, git. On a clean machine this
// must come from the bundled PortableGit (Pi `shellPath`, set by the app), never WSL.
const AGENT_COMMAND =
  `${BASH_COMMAND}; echo BASH_VERSION=$BASH_VERSION; [[ 1 == 1 ]] && arr=(a b) && echo "bashisms=\${arr[1]}"; ` +
  `git --version; ls | head -5 | tr "\\n" " "; echo; grep -c . fixture.txt; sed -n 1p fixture.txt; ` +
  `awk "BEGIN{print 6*7}"; find . -maxdepth 1 -name "*.txt"; echo GIT_ROOT=$(cygpath -w /); ` +
  // Russian output from the bundled Python (needs UTF-8 stdout; Windows pipes default to ANSI).
  `echo PY=$(command -v python3); python3 -c "print('привет')"`;

test("clean Windows (system Git hidden): bash tool via bundled Git", async () => {
  test.skip(process.platform !== "win32", "Windows only");
  let launched: Launched | undefined;
  try {
    launched = await launch("clean", { hideGitBash: true, bashCommand: AGENT_COMMAND });
    await startHost(launched.page);
    const bash = await runBashTurn(launched, "clean");
    const report = `bash tool result:\n${bash.result}`;
    if (!strictCleanBash) {
      if (!bash.ok) test.info().annotations.push({ type: "clean-bash", description: report });
      return;
    }
    expect(bash.result, report).toMatch(HARNESS_HEADER);
    expect(bash.result, report).toContain(MARKER);
    expect(bash.result, report).toContain("bashisms=b");
    expect(bash.result, report).toMatch(/git version \d/);
    expect(bash.result, report).toContain("PRSLOY smoke fixture");
    expect(bash.result, report).toMatch(/^42$/m);
    expect(bash.result, report).toContain("./fixture.txt");
    expect(bash.result, report).not.toMatch(/command not found|Windows Subsystem for Linux/);
    // Bundled Git lives under userData\runtimes (not Program Files, not WSL).
    expect(bash.result, report).toMatch(/GIT_ROOT=.*\\runtimes\\/i);
    const ru = findings("encoding", process.env.SMOKE_STRICT_RU === "1");
    ru.check("bundled python3 prints привет", /^привет$/m.test(bash.result), report);
    await ru.finish();
  } finally {
    if (launched) await shot(launched.page, "99-clean-final");
    await close(launched);
  }
});
