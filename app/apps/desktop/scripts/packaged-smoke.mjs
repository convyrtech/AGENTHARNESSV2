/**
 * Smoke test of the PACKAGED app (electron-builder output), first launch from a clean
 * profile, against a local mock PRSLOY gateway. Runs after `pnpm package`:
 *
 *   - Windows (CI windows-latest): always; Linux/macOS only with PRSLOY_SMOKE=1
 *   - report-only by default; PRSLOY_SMOKE_STRICT=1 makes failures fail the build
 *
 * Measures (ms from launch): window, bootstrap ready (runtimes extracted), key saved,
 * host ready, first agent turn with a bash call done, bundled Git ready. Checks: the bash
 * call ran bundled git + the python3 shim, the harness header is on the tool result, the
 * agent env has no machine secret, the gateway key appears in no file or log, and (Windows)
 * the key's directory ACL is user-only.
 *
 * Output: one `[packaged-smoke] {json}` line and release/app/packaged-smoke.json.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE = join(DESKTOP, "release", "app");

export function packagedExecutable(platform = process.platform) {
  if (platform === "win32") return join(RELEASE, "win-unpacked", "PRSLOY.exe");
  if (platform === "linux") return join(RELEASE, "linux-unpacked", "PRSLOY");
  return join(RELEASE, "mac", "PRSLOY.app", "Contents", "MacOS", "PRSLOY");
}

/** Mock OpenAI-compatible gateway: GET /v1/models + scripted streaming turns. */
function startGateway(key, turns) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const authorized = req.headers.authorization === `Bearer ${key}`;
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(authorized ? 200 : 401, { "content-type": "application/json" });
      res.end(JSON.stringify(authorized ? { data: [{ id: "deepseek-v4.1-flash-1017" }] } : {}));
      return;
    }
    if (req.method !== "POST" || req.url !== "/v1/chat/completions" || !authorized) {
      res.writeHead(authorized ? 404 : 401).end();
      return;
    }
    requests.push(JSON.parse(raw || "{}"));
    const turn = turns.shift() ?? { text: "ok" };
    const chunk = (delta, finish = null) =>
      res.write(
        `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
      );
    res.writeHead(200, { "content-type": "text/event-stream" });
    chunk({ role: "assistant", content: "" });
    if (turn.tool) {
      chunk({
        tool_calls: [
          {
            index: 0,
            id: `call-${requests.length}`,
            type: "function",
            function: { name: "bash", arguments: JSON.stringify({ command: turn.tool }) },
          },
        ],
      });
      chunk({}, "tool_calls");
    } else {
      chunk({ content: turn.text });
      chunk({}, "stop");
    }
    res.end("data: [DONE]\n\n");
  });
  return new Promise((resolveStart) =>
    server.listen(0, "127.0.0.1", () =>
      resolveStart({ server, requests, baseUrl: `http://127.0.0.1:${server.address().port}/v1` }),
    ),
  );
}

function filesUnder(root, out = []) {
  if (!existsSync(root)) return out;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "runtimes" || entry.name === "node_modules") continue;
      filesUnder(path, out);
    } else if (entry.isFile() && statSync(path).size < 20 * 1024 * 1024) out.push(path);
  }
  return out;
}

function windowsAcl(path) {
  if (process.platform !== "win32" || !existsSync(path)) return undefined;
  try {
    return execFileSync("icacls", [path], { encoding: "utf8", windowsHide: true }).trim();
  } catch (error) {
    return `icacls failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** True when the ACL grants nobody but one account (no Users / Everyone / inherited). */
export function aclIsUserOnly(icaclsOutput, path) {
  const lines = icaclsOutput
    .split(/\r?\n/u)
    .map((l) => l.trim())
    .filter((l) => l && !/^Successfully processed/iu.test(l));
  const grants = lines
    .map((l, i) =>
      i === 0
        ? (path && l.startsWith(path) ? l.slice(path.length) : l.slice(l.indexOf(" "))).trim()
        : l,
    )
    .filter((l) => /:\(/u.test(l));
  if (
    grants.some((g) => /\b(Everyone|Users|Authenticated Users|BUILTIN\\Users)\b|\(I\)/iu.test(g))
  ) {
    return false;
  }
  return grants.length === 1;
}

export async function runPackagedSmoke() {
  const exe = packagedExecutable();
  const report = { exe, ok: false, checks: {}, timingsMs: {}, errors: [] };
  if (!existsSync(exe)) {
    report.errors.push(`packaged executable not found: ${exe}`);
    return report;
  }
  const { _electron: electron } = await import("playwright");
  const key = `sk-prsloy-smoke-${randomUUID()}`;
  const planted = `ghp_smoke_${randomUUID().slice(0, 8)}`;
  const root = join(tmpdir(), `prsloy-smoke-${Date.now()}`);
  const userData = join(root, "userData");
  const agentDir = join(root, "agent");
  const workspace = join(root, "workspace");
  for (const dir of [userData, agentDir, workspace]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(workspace, "README.md"), "smoke\n");

  const gateway = await startGateway(key, [
    { tool: "git --version && python3 -c 'print(40+2)' && echo token=${GH_TOKEN:-none}" },
    { text: "done" },
  ]);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  Object.assign(env, {
    ZENO_ENABLE_TEST_COMMANDS: "1",
    PI_CODING_AGENT_DIR: agentDir,
    ZENO_WORKSPACE: workspace,
    ZENO_MODEL_PROVIDER: "prsloy",
    ZENO_MODEL_ID: "deepseek-v4.1-flash-1017",
    ZENO_TOOLS: "read,bash",
    ZENO_PERSIST_SESSION: "1",
    ZENO_NO_AUTO_RESUME: "1",
    PRSLOY_NO_UPDATE: "1",
    GH_TOKEN: planted,
  });

  const output = [];
  const t0 = Date.now();
  const mark = (name) => (report.timingsMs[name] = Date.now() - t0);
  let app;
  try {
    app = await electron.launch({
      executablePath: exe,
      args: [`--user-data-dir=${userData}`, "--lang=ru"],
      env,
      timeout: 180_000,
    });
    app.process().stdout?.on("data", (b) => output.push(String(b)));
    app.process().stderr?.on("data", (b) => output.push(String(b)));
    const page = await app.firstWindow({ timeout: 180_000 });
    mark("window");
    await page.waitForSelector('[data-testid="zeno-app"]', { timeout: 180_000 });
    await page.evaluate(() =>
      localStorage.setItem(
        "prsloy.casual.prefs.v1",
        JSON.stringify({ developerMode: true, rubPerUsd: 95 }),
      ),
    );
    await page.reload();
    await page.waitForSelector('[data-testid="zeno-app"][data-bootstrap-ready="true"]', {
      timeout: 300_000,
    });
    mark("bootstrapReady");

    const setKey = await page.evaluate(
      ([k, url]) => window.zeno.prsloy.setKey(k, url),
      [key, gateway.baseUrl],
    );
    report.checks.keyAccepted = Boolean(setKey?.ok);
    mark("keySaved");

    // Bundled Git unpacks in the background; record when it is ready.
    const gitWatch = (async () => {
      for (;;) {
        const state = await page
          .evaluate(() => window.zeno.prsloy.getState())
          .catch(() => undefined);
        const status = state?.gitSetup?.status;
        if (status && status !== "installing") {
          report.checks.gitSetup = status;
          mark("gitReady");
          return;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    })();

    // Same as e2e startHost(): a host may already run from bootstrap; wait for a NEW runtime.
    const runtimeIdNow = () =>
      page.evaluate(
        () =>
          /"runtimeId":\s*"([^"]+)"/u.exec(
            document.querySelector('[data-testid="runtime-snapshot"]')?.textContent ?? "",
          )?.[1] ?? "",
      );
    const previousRuntimeId = await runtimeIdNow();
    await page.getByTestId("start-host").click({ force: true, timeout: 60_000 });
    await page.waitForFunction(
      (previous) => {
        const id = /"runtimeId":\s*"([^"]+)"/u.exec(
          document.querySelector('[data-testid="runtime-snapshot"]')?.textContent ?? "",
        )?.[1];
        return Boolean(id) && id !== previous;
      },
      previousRuntimeId,
      { timeout: 180_000 },
    );
    await page.waitForFunction(
      () =>
        /ready|готов/iu.test(
          document.querySelector('[data-testid="host-status"]')?.textContent ?? "",
        ),
      undefined,
      { timeout: 180_000 },
    );
    mark("hostReady");
    await page.getByTestId("prompt-input").fill("Проверь окружение.");
    await page.getByTestId("send-prompt").click();
    await page.waitForFunction(
      () =>
        /Agent settled/u.test(
          document.querySelector('[data-testid="host-status"]')?.textContent ?? "",
        ),
      undefined,
      { timeout: Number(process.env.PRSLOY_SMOKE_TURN_MS ?? 300_000) },
    );
    mark("firstTurnDone");
    await Promise.race([gitWatch, new Promise((r) => setTimeout(r, 1_000))]);

    const toolText = JSON.stringify(gateway.requests[1]?.messages ?? []);
    report.checks.bashRanGit = /git version/u.test(toolText);
    report.checks.python3Shim = /\\n42|\b42\b/u.test(toolText);
    report.checks.harnessHeader = /\[exit 0 ·/u.test(toolText);
    report.checks.agentEnvScrubbed = toolText.includes("token=none") && !toolText.includes(planted);
    report.checks.keyNotInToolOutput = !toolText.includes(key);
  } catch (error) {
    report.errors.push(error instanceof Error ? error.message : String(error));
    try {
      const page = app?.windows()[0];
      report.debug = {
        gatewayRequests: gateway.requests.length,
        hostStatus: await page?.getByTestId("host-status").first().textContent({ timeout: 2_000 }),
        outputTail: output.join("").slice(-1500),
      };
      await page?.screenshot({ path: join(RELEASE, "packaged-smoke-failure.png") });
    } catch {
      // best effort
    }
  } finally {
    await app?.close().catch(() => undefined);
    gateway.server.close();
  }

  const leaks = filesUnder(root).filter((file) => readFileSync(file, "latin1").includes(key));
  report.checks.keyNotInFiles = leaks.length === 0;
  if (leaks.length) report.errors.push(`key found in: ${leaks.join(", ")}`);
  report.checks.keyNotInLogs = !output.join("").includes(key);
  const stateDir = join(userData, "prsloy");
  const acl = windowsAcl(stateDir);
  if (acl !== undefined) {
    report.acl = acl;
    report.checks.keyDirUserOnly = aclIsUserOnly(acl, stateDir);
  }
  // Bundled Git exists only on Windows; elsewhere "absent" is the correct state.
  const gitOk = (v) => v === "ready" || (process.platform !== "win32" && v === "absent");
  report.ok =
    report.errors.length === 0 &&
    Object.entries(report.checks).every(([name, v]) =>
      name === "gitSetup" ? gitOk(v) : v === true,
    );
  rmSync(root, { recursive: true, force: true });
  return report;
}

const isCliEntry =
  typeof process.argv[1] === "string" &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isCliEntry) {
  if (process.platform !== "win32" && process.env.PRSLOY_SMOKE !== "1") {
    console.log("[packaged-smoke] skipped (Windows only; PRSLOY_SMOKE=1 to force)");
  } else if (process.env.PRSLOY_SKIP_SMOKE === "1") {
    console.log("[packaged-smoke] skipped (PRSLOY_SKIP_SMOKE=1)");
  } else {
    const report = await runPackagedSmoke();
    console.log(`[packaged-smoke] ${JSON.stringify(report)}`);
    try {
      mkdirSync(RELEASE, { recursive: true });
      writeFileSync(join(RELEASE, "packaged-smoke.json"), `${JSON.stringify(report, null, 2)}\n`);
    } catch {
      // report already printed
    }
    if (!report.ok && process.env.PRSLOY_SMOKE_STRICT === "1") process.exit(1);
  }
}
