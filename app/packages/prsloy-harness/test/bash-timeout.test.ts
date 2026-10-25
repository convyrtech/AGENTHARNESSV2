import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { join, resolve as resolvePath } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { installBashTimeout } from "../src/bash-timeout.ts";
import { contentText } from "../src/text.ts";
import { resolveOptions } from "../src/options.ts";
import { detectPorts, looksLikeServer } from "../src/process-registry.ts";
import { MockPi } from "./mock-pi.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function project() {
  const dir = await mkdtemp(join(tmpdir(), "prsloy-bg-"));
  dirs.push(dir);
  await writeFile(
    join(dir, "server.js"),
    `const http = require("node:http");
const s = http.createServer((q, r) => r.end("ok"));
s.listen(0, "127.0.0.1", () => console.log("ready on http://localhost:" + s.address().port));`,
  );
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "x", scripts: { dev: "node server.js" } }),
  );
  return dir;
}

function setup(cwd = process.cwd()) {
  const pi = new MockPi(cwd);
  const opts = resolveOptions({ outputDir: join(cwd, ".harness-out") });
  const registry = installBashTimeout(pi.api, opts);
  return { pi, registry };
}

describe("bash timeout", () => {
  it("sets a 120 s default and caps what the model asks for", async () => {
    const { pi } = setup();
    const input: Record<string, unknown> = { command: "ls" };
    await pi.toolCall("bash", input);
    expect(input.timeout).toBe(120);
    const long: Record<string, unknown> = { command: "make", timeout: 99_999 };
    await pi.toolCall("bash", long);
    expect(long.timeout).toBe(600);
    const ps: Record<string, unknown> = { command: "Get-ChildItem" };
    await pi.toolCall("powershell", ps);
    expect(ps.timeout).toBe(120);
  });

  it("rewrites Pi's timeout error into a Russian note that the process was stopped", async () => {
    const { pi } = setup();
    const result = await pi.toolResult({
      toolName: "bash",
      isError: true,
      text: "building...\nstep 3\n\nCommand timed out after 120 seconds",
    });
    expect(result.text).toContain("step 3");
    expect(result.text).toContain("[Процесс остановлен по таймауту 120 с.]");
    expect(result.text).toContain("bash_background");
    expect(result.text).not.toContain("Command timed out");
  });

  it("moves a dev server to the background with pid, port and log", async () => {
    const dir = await project();
    const { pi, registry } = setup(dir);
    const blocked = await pi.toolCall("bash", { command: "npm run dev" });
    try {
      expect(blocked?.block).toBe(true);
      expect(blocked?.reason).toContain("запущена в фоне");
      expect(blocked?.reason).toMatch(/порт \d+/);
      const [proc] = registry.list();
      expect(proc?.exitCode).toBeUndefined();
      const port = proc?.ports[0];
      const response = await fetch(`http://127.0.0.1:${port}/`);
      expect(await response.text()).toBe("ok");

      const list = await pi
        .tool("process")
        .execute("t1", { action: "list" }, undefined, undefined, pi.ctx as never);
      expect(contentText(list.content)).toContain("bg1: работает");
      const logs = await pi
        .tool("process")
        .execute("t2", { action: "logs", id: "bg1" }, undefined, undefined, pi.ctx as never);
      expect(contentText(logs.content)).toContain("ready on http://localhost:");
    } finally {
      await pi.emit("session_shutdown", {});
    }
    await new Promise((r) => setTimeout(r, 300));
    expect(registry.list()[0]?.exitCode).not.toBeUndefined();
  });

  it("bash_background starts a command and process stop kills it", async () => {
    const dir = await project();
    const { pi, registry } = setup(dir);
    const started = await pi
      .tool("bash_background")
      .execute(
        "t",
        { command: "node server.js", wait_seconds: 5 },
        undefined,
        undefined,
        pi.ctx as never,
      );
    expect(contentText(started.content)).toMatch(/bg1: работает, pid \d+, порт \d+/);
    await pi
      .tool("process")
      .execute("t", { action: "stop", id: "bg1" }, undefined, undefined, pi.ctx as never);
    await new Promise((r) => setTimeout(r, 300));
    expect(registry.get("bg1")?.exitCode).not.toBeUndefined();
    await expect(
      pi
        .tool("process")
        .execute("t", { action: "logs", id: "bg9" }, undefined, undefined, pi.ctx as never),
    ).rejects.toThrow("Нет процесса bg9");
  });
});

describe("servers via & and kill commands", () => {
  it("routes `(server &)` to the registry and keeps the rest of the command", async () => {
    const dir = await project();
    const { pi, registry } = setup(dir);
    const input: Record<string, unknown> = {
      command: "(node server.js > /dev/null 2>&1 &) && sleep 1 && echo next",
    };
    try {
      expect(await pi.toolCall("bash", input, "c1")).toBeUndefined();
      expect(input.command).toBe("(:;) && sleep 1 && echo next");
      const [proc] = registry.list();
      expect(proc).toMatchObject({ command: "node server.js", exitCode: undefined });
      expect(proc?.ports.length).toBe(1);
      const result = await pi.toolResult({ toolName: "bash", toolCallId: "c1", text: "next" });
      expect(result.text).toContain("запущен через реестр харнесса");
      expect(result.text).toMatch(/bg1: работает, pid \d+, порт \d+/);

      // pkill -f по этому серверу идёт через реестр, а не убивает bash.
      const kill: Record<string, unknown> = { command: 'pkill -f "node server.js"; echo done' };
      expect(await pi.toolCall("bash", kill, "c2")).toBeUndefined();
      expect(kill.command).toBe(":; echo done");
      expect(registry.get("bg1")?.exitCode).not.toBeUndefined();
      const killed = await pi.toolResult({ toolName: "bash", toolCallId: "c2", text: "done" });
      expect(killed.text).toContain("выполнено через реестр: остановлены bg1");
    } finally {
      await pi.emit("session_shutdown", {});
    }
  });

  it("registry matching does not treat bare numbers in a pkill pattern as ports", async () => {
    const dir = await project();
    const { pi, registry } = setup(dir);
    try {
      await pi.toolCall("bash", { command: "node server.js &" });
      const port = registry.list()[0]?.ports[0];
      expect(registry.matching(`sleep 400.${port}`)).toEqual([]);
      expect(registry.matching(`:${port}`).map((p) => p.id)).toEqual(["bg1"]);
      expect(registry.matching("server.js").map((p) => p.id)).toEqual(["bg1"]);
    } finally {
      await pi.emit("session_shutdown", {});
    }
  });

  it("process stop by port", async () => {
    const dir = await project();
    const { pi, registry } = setup(dir);
    try {
      await pi.toolCall("bash", { command: "node server.js &" });
      const port = registry.list()[0]?.ports[0];
      const out = await pi
        .tool("process")
        .execute("t", { action: "stop", port }, undefined, undefined, pi.ctx as never);
      expect(contentText(out.content)).toBe(`bg1 (порт ${port}) остановлен.`);
      const none = await pi
        .tool("process")
        .execute("t", { action: "stop", port: 1 }, undefined, undefined, pi.ctx as never);
      expect(contentText(none.content)).toBe("Порт 1 никто не слушает.");
    } finally {
      await pi.emit("session_shutdown", {});
    }
  });

  it("blocks killing the tool's own shell or the app", async () => {
    const { pi } = setup();
    for (const command of ["pkill bash", "killall node", "taskkill /F /IM node.exe"]) {
      const blocked = await pi.toolCall("bash", { command });
      expect(blocked?.block).toBe(true);
      expect(blocked?.reason).toContain("process action=stop");
    }
  });

  it.skipIf(process.platform === "win32")(
    "rewrites other pkill -f so it skips the tool's process group",
    async () => {
      const { pi } = setup();
      const input: Record<string, unknown> = { command: 'pkill -f "http.server 8099"; echo ok' };
      expect(await pi.toolCall("bash", input)).toBeUndefined();
      expect(String(input.command).startsWith("__prsloy_pkill() {")).toBe(true);
      expect(input.command).toContain("__prsloy_pkill TERM '-f' 'http.server 8099'; echo ok");
    },
  );

  it("leaves ordinary background jobs alone", async () => {
    const { pi, registry } = setup();
    const input: Record<string, unknown> = { command: "sleep 1 & sleep 1 & wait" };
    await pi.toolCall("bash", input);
    expect(input.command).toBe("sleep 1 & sleep 1 & wait");
    expect(registry.list()).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32")("host killed by a signal", () => {
  it("background servers die with the host even without session_shutdown", async () => {
    const dir = await mkdtemp(join(tmpdir(), "prsloy-sig-"));
    dirs.push(dir);
    const registryPath = resolvePath(import.meta.dirname, "../src/process-registry.ts");
    const script = join(dir, "host.ts");
    await writeFile(
      script,
      `import { ProcessRegistry } from ${JSON.stringify(registryPath)};
const r = new ProcessRegistry(${JSON.stringify(join(dir, "logs"))}, () => process.env);
const p = await r.start("node -e \\"require('http').createServer(()=>{}).listen(0, () => console.log('port ok'))\\"", ${JSON.stringify(dir)}, 3000);
console.log("PID " + p.pid);
setInterval(() => {}, 1000);
`,
    );
    const jiti = resolvePath(import.meta.dirname, "../node_modules/.bin/jiti");
    const host = spawn(jiti, [script], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    host.stdout.on("data", (d: Buffer) => (out += d.toString()));
    for (let i = 0; i < 100 && !/PID \d+/.test(out); i++)
      await new Promise((r) => setTimeout(r, 100));
    const pid = Number(/PID (\d+)/.exec(out)?.[1]);
    expect(pid).toBeGreaterThan(0);
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(alive()).toBe(true);
    host.kill("SIGTERM");
    for (let i = 0; i < 50 && alive(); i++) await new Promise((r) => setTimeout(r, 100));
    expect(alive()).toBe(false);
  }, 20_000);
});

describe("looksLikeServer", () => {
  it.each([
    "npm run dev",
    "pnpm dev",
    "yarn start",
    "cd web && npm run dev",
    "npx vite",
    "vite",
    "python3 -m http.server 8000",
    "uvicorn app:app --reload",
    "flask run",
    "next dev",
    "tsc --watch",
    "npx serve dist",
    "npx -y vite --port 3000",
    "FOO=1 npm run dev",
    "python manage.py runserver",
    "bin/rails s",
    "docker compose up",
    "cargo watch -x run",
    "vitest --watch",
  ])("server: %s", (command) => {
    expect(looksLikeServer(command)).toBe(true);
  });

  it.each([
    "npm test",
    "npm run build",
    "vite build",
    "npm run dev &",
    "timeout 5 npm run dev",
    "ls -la",
    "node script.js",
    "pnpm install",
  ])("not a server: %s", (command) => {
    expect(looksLikeServer(command)).toBe(false);
  });
});

describe("detectPorts", () => {
  it("finds ports in common banners", () => {
    expect(detectPorts("  ➜  Local:   http://localhost:5173/")).toEqual([5173]);
    expect(detectPorts("Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/)")).toEqual([8000]);
    expect(detectPorts("no port here, version 1.2.3")).toEqual([]);
    expect(
      detectPorts("Port 3000 is in use, trying another one...\n  Local: http://localhost:3001/"),
    ).toEqual([3001]);
    expect(detectPorts("listening on http://[::1]:8080")).toEqual([8080]);
  });
});
