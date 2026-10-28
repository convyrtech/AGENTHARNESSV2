// #82: границы ожидания bash-тула. Замер до правки: timeout=5 при потомке в отдельной сессии,
// который пишет в пайп 20 раз в секунду, заканчивался на 15.4 с, а отмена на 2.5 с — тоже на 15.4 с.
// Здесь проверяется обратное: вызов кончается не позже своей границы и выход по отмене/таймауту виден.
import { getShellConfig } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vite-plus/test";
import {
  boundedBashOperations,
  DRAIN_AFTER_EXIT_MS,
  KILL_SETTLE_MS,
  type BoundedExecOptions,
  type ExecBoundary,
  waitForBoundedExit,
} from "../src/bash-exec.ts";

const posixOnly = process.platform === "win32" ? it.skip : it;

function ops(extra: BoundedExecOptions = {}) {
  return boundedBashOperations(() => getShellConfig(), extra);
}

/** Потомок в своей сессии (setsid) переживает kill группы и продолжает писать в пайп тула. */
const CHATTY_ESCAPEE = `setsid sh -c 'while :; do echo tick; sleep 0.02; done' &`;

async function run(
  command: string,
  options: {
    timeout?: number;
    signal?: AbortSignal;
    boundaries?: ExecBoundary[];
    extra?: BoundedExecOptions;
  } = {},
) {
  let output = "";
  const startedAt = Date.now();
  let error: Error | undefined;
  let exitCode: number | null | undefined;
  try {
    const result = await ops({
      ...options.extra,
      onBoundary: (e) => options.boundaries?.push(e),
    }).exec(command, process.cwd(), {
      onData: (data) => {
        output += data.toString();
      },
      ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    exitCode = result.exitCode;
  } catch (err) {
    error = err as Error;
  }
  return { output, exitCode, error, elapsedMs: Date.now() - startedAt };
}

describe("bash exec: границы ожидания (#82)", () => {
  it("обычная команда отдаёт код, вывод и stderr", async () => {
    const ok = await run("echo hi");
    expect(ok.error).toBeUndefined();
    expect(ok.exitCode).toBe(0);
    expect(ok.output.trim()).toBe("hi");

    const bad = await run("echo out; echo err >&2; exit 3");
    expect(bad.exitCode).toBe(3);
    expect(bad.output).toContain("out");
    expect(bad.output).toContain("err");
  });

  it("не теряет хвост вывода: команда пишет и сразу выходит", async () => {
    const res = await run("for i in 1 2 3 4 5; do echo line$i; done");
    expect(res.exitCode).toBe(0);
    expect(res.output).toContain("line5");
  });

  it("большой вывод приходит целиком (обрезку делает тул, не exec)", async () => {
    const res = await run("seq 1 20000");
    expect(res.exitCode).toBe(0);
    expect(res.output.trim().split("\n").length).toBe(20000);
  });

  posixOnly("таймаут срабатывает, даже если потомок остался жив и пишет в пайп", async () => {
    const boundaries: ExecBoundary[] = [];
    const res = await run(`${CHATTY_ESCAPEE} sleep 30`, {
      timeout: 1,
      boundaries,
      // Границы по умолчанию: после kill ждём не дольше KILL_SETTLE_MS.
    });
    expect(res.error?.message).toBe("timeout:1");
    // До правки здесь было ~15 с (Pi ждал молчания пайпа, а потомок не замолкал).
    expect(res.elapsedMs).toBeLessThan(KILL_SETTLE_MS + 2_500);
    expect(boundaries.some((b) => b.reason === "timeout")).toBe(true);
  });

  posixOnly("отмена завершает вызов, а не ждёт потомка", async () => {
    const controller = new AbortController();
    const boundaries: ExecBoundary[] = [];
    setTimeout(() => controller.abort(), 800);
    const res = await run(`${CHATTY_ESCAPEE} sleep 30`, {
      signal: controller.signal,
      boundaries,
    });
    expect(res.error?.message).toBe("aborted");
    expect(res.elapsedMs).toBeLessThan(800 + KILL_SETTLE_MS + 1_500);
    expect(boundaries.some((b) => b.reason === "abort")).toBe(true);
  });

  posixOnly("оболочка вышла, а потомок держит пайп — вызов всё равно заканчивается", async () => {
    const boundaries: ExecBoundary[] = [];
    const res = await run(`${CHATTY_ESCAPEE} echo started`, { boundaries });
    expect(res.error).toBeUndefined();
    expect(res.exitCode).toBe(0);
    expect(res.output).toContain("started");
    // Не больше выхода оболочки + границы чтения хвоста (+ запас на медленную машину).
    expect(res.elapsedMs).toBeLessThan(DRAIN_AFTER_EXIT_MS + 2_500);
    expect(boundaries.some((b) => b.reason === "drain")).toBe(true);
  });

  it("abort до старта команды не запускает её", async () => {
    const controller = new AbortController();
    controller.abort();
    const res = await run("echo never", { signal: controller.signal });
    expect(res.error?.message).toBe("aborted");
    expect(res.output).toBe("");
  });

  it("несуществующий рабочий каталог — понятная ошибка, а не зависание", async () => {
    const res = await ops()
      .exec("echo hi", "/nope/not-here", { onData: () => {} })
      .then(() => undefined)
      .catch((err: Error) => err);
    expect(res).toBeInstanceOf(Error);
    expect((res as Error).message).toContain("Working directory does not exist");
  });
});

// Ревью #82 (gpt-6.1-sol, gemini-4-argon): граница ставилась только если `aborted || timedOut`
// уже истинно до старта ожидания, то есть никогда. Здесь проверяется именно граница задним числом.
describe("waitForBoundedExit: граница ставится после kill (#82)", () => {
  posixOnly("armHardCap закрывает ожидание, даже если процесс жив и молчит", async () => {
    const child = spawn("sleep", ["30"], { stdio: ["ignore", "pipe", "pipe"] });
    const wait = waitForBoundedExit(child, { drainAfterExitMs: 60_000 });
    const startedAt = Date.now();
    wait.armHardCap(300);
    const res = await wait;
    child.kill("SIGKILL");
    expect(res.forced).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  posixOnly("без границы живой процесс не отпускает ожидание само по себе", async () => {
    const child = spawn("sleep", ["30"], { stdio: ["ignore", "pipe", "pipe"] });
    const wait = waitForBoundedExit(child, { drainAfterExitMs: 120, drainIdleMs: 120 });
    let settled = false;
    void wait.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 400));
    // Процесс жив и ничего не пишет — ожидание не должно закончиться само.
    expect(settled).toBe(false);
    wait.armHardCap(50);
    const res = await wait;
    child.kill("SIGKILL");
    expect(res.forced).toBe(true);
  });

  posixOnly("armHardCap после выхода ничего не ломает", async () => {
    const child = spawn("sh", ["-c", "echo ok"], { stdio: ["ignore", "pipe", "pipe"] });
    const wait = waitForBoundedExit(child);
    const res = await wait;
    wait.armHardCap(50);
    expect(res.exitCode).toBe(0);
    expect(res.forced).toBe(false);
  });
});
