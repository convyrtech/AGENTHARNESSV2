import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  cleanJob,
  cwdBefore,
  findBackgroundJobs,
  findKillCommands,
  isBackgroundServer,
  isProtectedTarget,
  replaceRanges,
  SAFE_PKILL_FUNCTION,
  safePkillCall,
} from "../src/shell-rewrite.ts";

const jobsOf = (command: string) => findBackgroundJobs(command)?.map((j) => j.command);

describe("findBackgroundJobs", () => {
  it("finds jobs sent to the background with a single &", () => {
    expect(jobsOf("(python3 -m http.server 8099 > /dev/null 2>&1 &)")).toEqual([
      "python3 -m http.server 8099",
    ]);
    expect(jobsOf("npm run dev & sleep 2; curl -s localhost:5173")).toEqual(["npm run dev"]);
    expect(jobsOf("cd site && nohup node server.js >log.txt 2>&1 &")).toEqual([
      "cd site && node server.js",
    ]);
    expect(jobsOf("vite --port 3000 &> vite.log &\necho started")).toEqual(["vite --port 3000"]);
  });

  it("ignores &&, redirections, quoted & and command substitution", () => {
    expect(jobsOf("echo a && echo b 2>&1")).toEqual([]);
    expect(jobsOf("echo \"a & b\" 'c & d'")).toEqual([]);
    expect(jobsOf("x=$(sleep 1 &) ; echo $x")).toEqual([]);
    expect(jobsOf("ls # comment & not a job")).toEqual([]);
  });

  it("returns undefined when quotes or parentheses do not balance", () => {
    expect(findBackgroundJobs('echo "oops &')).toBeUndefined();
    expect(findBackgroundJobs("(sleep 1 &")).toBeUndefined();
  });

  it("cleanJob drops nohup/setsid and output redirections", () => {
    expect(cleanJob("nohup setsid python3 -m http.server 8000 > /tmp/s.log 2>&1")).toBe(
      "python3 -m http.server 8000",
    );
  });
});

describe("isBackgroundServer", () => {
  it.each([
    "python3 -m http.server 8099",
    "cd site && node server.js",
    "npm run dev",
    "node server.js",
    "python app.py",
    "bun run index.ts",
  ])("server: %s", (job) => expect(isBackgroundServer(job)).toBe(true));
  it.each(["sleep 5", "npm test", "node build.js", "python train.py", "make -j4"])(
    "not a server: %s",
    (job) => expect(isBackgroundServer(job)).toBe(false),
  );
});

describe("cwdBefore", () => {
  it("applies cd before the job", () => {
    const cmd = "cd site && python3 -m http.server 8000 &";
    expect(cwdBefore(cmd, cmd.indexOf("python3"), "/w")).toBe(join("/w", "site"));
    const nested = "cd a; (cd b && npm run dev &)";
    expect(cwdBefore(nested, nested.indexOf("npm"), "/w")).toBe(join("/w", "a", "b"));
  });
  it("gives up on cd with variables", () => {
    const cmd = 'cd "$DIR" && npm run dev &';
    expect(cwdBefore(cmd, cmd.indexOf("npm"), "/w")).toBeUndefined();
  });
});

describe("findKillCommands", () => {
  it("parses pkill -f, signals, killall and taskkill", () => {
    const [p] = findKillCommands('sleep 1; pkill -9 -f "http.server 8099"; echo ok');
    expect(p).toMatchObject({
      tool: "pkill",
      target: "http.server 8099",
      fullCommandLine: true,
      signal: "9",
    });
    expect(p?.raw).toBe('pkill -9 -f "http.server 8099"');
    expect(findKillCommands("killall python3")[0]).toMatchObject({
      tool: "killall",
      target: "python3",
      fullCommandLine: false,
    });
    expect(findKillCommands("taskkill /F /IM node.exe")[0]).toMatchObject({
      tool: "taskkill",
      target: "node.exe",
    });
    expect(findKillCommands("echo pkill -f x")).toEqual([]);
  });

  it("protects the tool's own shell and the app", () => {
    for (const t of ["bash", "sh", "node", "node.exe", "bash.exe", "electron", "prsloy"])
      expect(isProtectedTarget(t)).toBe(true);
    for (const t of ["python3", "http.server 8099", "vite"])
      expect(isProtectedTarget(t)).toBe(false);
  });

  it("replaceRanges keeps the rest of the command", () => {
    const cmd = "(python3 -m http.server 8099 &) && curl x";
    const [job] = findBackgroundJobs(cmd) ?? [];
    expect(replaceRanges(cmd, [{ start: job!.start, end: job!.end + 1, text: ":;" }])).toBe(
      "(:;) && curl x",
    );
  });
});

describe.skipIf(process.platform === "win32")("pkill -f inside bash -c (real processes)", () => {
  const marker = `sleep ${300 + Math.floor(Math.random() * 1000)}.${process.pid}`;
  const victim = () => {
    const child = spawn("sh", ["-c", `exec ${marker}`], { detached: true, stdio: "ignore" });
    child.unref();
    return child;
  };
  const alive = () => spawnSync("pgrep", ["-f", `^${marker}`]).status === 0;

  it("plain pkill -f kills its own shell (exit 143) — the bug from live acceptance", async () => {
    const v = victim();
    await new Promise((r) => setTimeout(r, 200));
    const r = spawnSync("bash", ["-c", `pkill -f "${marker}"; echo survived`], {
      encoding: "utf8",
      detached: true,
    } as never);
    expect(r.stdout).not.toContain("survived");
    expect(r.status === 143 || r.signal === "SIGTERM").toBe(true);
    v.kill("SIGKILL");
  });

  it("the rewritten pkill kills the target and keeps the shell alive", async () => {
    const v = victim();
    await new Promise((r) => setTimeout(r, 200));
    expect(alive()).toBe(true);
    const [kill] = findKillCommands(`pkill -f "${marker}"`);
    const script = `${SAFE_PKILL_FUNCTION}\n${safePkillCall(kill!)}; echo rc=$?`;
    const r = spawnSync("bash", ["-c", script], { encoding: "utf8", detached: true } as never);
    expect(r.stdout).toContain("rc=0");
    expect(r.status).toBe(0);
    await new Promise((res) => setTimeout(res, 200));
    expect(alive()).toBe(false);
    v.kill("SIGKILL");
  });
});
