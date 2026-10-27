// Замер «до/после» для #82: одно и то же исполнение оболочки через встроенные operations Pi
// (как было) и через `bash-exec.ts` (как стало). Печатает время до завершения вызова и куда
// сработала граница. Ничего наружу не отправляет, платных запросов нет.
import { createLocalBashOperations, getShellConfig } from "@earendil-works/pi-coding-agent";
import { boundedBashOperations, type ExecBoundary } from "../../src/bash-exec.ts";

const command =
  process.argv[2] ?? `setsid sh -c 'while :; do echo tick; sleep 0.02; done' & sleep 30`;
const timeoutSec = Number(process.argv[3] ?? 5);
const abortAfterMs = Number(process.argv[4] ?? 0);
/** Жёсткий стоп замера: «до» может не закончиться вообще (это и есть баг). */
const hardStopMs = Number(process.argv[5] ?? 30_000);

type Outcome = { ms: number; outcome: string; boundary?: ExecBoundary };

async function measure(
  label: string,
  ops: ReturnType<typeof createLocalBashOperations>,
  boundaries: ExecBoundary[],
): Promise<Outcome> {
  const controller = new AbortController();
  const startedAt = Date.now();
  let timer: NodeJS.Timeout | undefined;
  if (abortAfterMs > 0) timer = setTimeout(() => controller.abort(), abortAfterMs);
  let outcome = "";
  try {
    const result = await Promise.race([
      ops.exec(command, process.cwd(), {
        onData: () => {},
        timeout: timeoutSec,
        signal: controller.signal,
      }),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error(`не завершился за ${hardStopMs} мс`)), hardStopMs),
      ),
    ]);
    outcome = `exit ${result.exitCode}`;
  } catch (err) {
    outcome = (err as Error).message.split("\n").pop() ?? String(err);
  } finally {
    if (timer) clearTimeout(timer);
  }
  const ms = Date.now() - startedAt;
  console.log(`${label}: ${ms} мс, ${outcome}`);
  return { ms, outcome, ...(boundaries[0] ? { boundary: boundaries[0] } : {}) };
}

const boundaries: ExecBoundary[] = [];
const before = await measure(
  "до (встроенные operations Pi)",
  createLocalBashOperations(),
  boundaries,
);
const after = await measure(
  "после (bash-exec.ts)",
  boundedBashOperations(() => getShellConfig(), {
    onBoundary: (event) => boundaries.push(event),
  }),
  boundaries,
);
console.log(
  `итог: до ${before.ms} мс → после ${after.ms} мс; граница: ${JSON.stringify(after.boundary ?? null)}`,
);
// Не выходим сами: живой потомок в отдельной сессии остался бы висеть в пайпах.
process.exit(0);
