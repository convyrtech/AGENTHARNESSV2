// Оффлайн-улучшатель (#33): папка `context/` для редакторов, композитора и рефлектора — только улики:
// просьба пользователя, стенограмма сессии (шаги [Sn], кто что написал), файлы, которые сделал агент, и деревья
// обвязки. Исхода проверки стенда здесь нет и быть не может: check.mjs, его вывод, ok/note отчёта не копируются,
// а перед выдачей модели папку проверяют tripwire'ы (leaks.ts).
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { normalizePi, readJsonl } from "../audit/ir.ts";
import { renderTranscript } from "../audit/judge.ts";
import { assertNoCheckText, assertNoGraderVerdicts, assertNoLeakPaths } from "./leaks.ts";
import { writeTree, type HarnessTree } from "./tree.ts";

/** Один прогон задачи: папка сессий и рабочая папка, как их оставил стенд. */
export interface Rollout {
  task: string;
  /** Подпись: base-1, INV-1, DOM-1, final-2… */
  label: string;
  sessionsDir: string;
  workspace: string | undefined;
}

const TEXT_FILE =
  /\.(?:md|txt|html?|css|js|mjs|ts|py|json|csv|tsv|ya?ml|toml|sh|bat|ps1|env\.example|ini)$/i;
const FILE_MAX = 20_000;
const FILES_MAX = 40;

/** Рабочая папка задачи в `<out>/work` (стенд называет её `<задача>-XXXXXX`). */
export function findWorkspace(outDir: string, task: string): string | undefined {
  const work = join(outDir, "work");
  if (!existsSync(work)) return undefined;
  const slug = task.replace(/\//g, "-");
  return readdirSync(work)
    .filter((n) => n.startsWith(`${slug}-`) && !n.startsWith(`${slug}-agent-`))
    .map((n) => join(work, n))[0];
}

/** Прогоны задач одного отчёта стенда (папки сессий и рабочие папки). */
export function rolloutsOf(outDir: string, tasks: readonly string[], label: string): Rollout[] {
  return tasks.map((task) => ({
    task,
    label,
    sessionsDir: join(outDir, "sessions", task.replace(/\//g, "-")),
    workspace: findWorkspace(outDir, task),
  }));
}

function producedFiles(workspace: string, original: string | undefined): string {
  const lines: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === "node_modules" || name === ".git" || name.startsWith(".prsloy")) continue;
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else {
        const rel = relative(workspace, p).split(sep).join("/");
        const before =
          original && existsSync(join(original, rel))
            ? readFileSync(join(original, rel), "utf8")
            : undefined;
        const body =
          TEXT_FILE.test(name) && st.size <= FILE_MAX ? readFileSync(p, "utf8") : undefined;
        const mark = before === undefined ? "new" : before === body ? "unchanged" : "changed";
        if (lines.length >= FILES_MAX * 4) continue;
        lines.push(`## ${rel} (${mark}, ${st.size} bytes)`);
        if (body !== undefined && mark !== "unchanged") lines.push("```", body, "```");
      }
    }
  };
  if (existsSync(workspace)) walk(workspace);
  return lines.join("\n") || "(no files)";
}

/** Стенограмма прогона: все сессии задачи по порядку, в формате судьи (шаги, авторство). */
function transcript(sessionsDir: string): string {
  if (!existsSync(sessionsDir)) return "(no session)";
  const files = readdirSync(sessionsDir)
    .filter((n) => n.endsWith(".jsonl") && !n.startsWith("prsloy-proxy"))
    .sort();
  return files
    .map((f, i) => {
      const s = normalizePi(readJsonl(join(sessionsDir, f)), { file: f });
      return `# Session ${i + 1}\n\n${renderTranscript(s)}`;
    })
    .join("\n\n");
}

export interface ContextInput {
  /** Куда собрать (папка `context`, затирается). */
  dir: string;
  /** Просьбы пользователя по задаче (task.json: prompt / prompts / variants). */
  requests: Readonly<Record<string, string[]>>;
  /** Исходные рабочие папки задач — чтобы отметить, что агент создал или поменял. */
  originals: Readonly<Record<string, string>>;
  base: HarnessTree;
  rollouts: readonly Rollout[];
  /** Деревья кандидатов (для композитора и рефлектора): подпись → дерево. */
  candidates?: Readonly<Record<string, HarnessTree>>;
  /** Заметки авторов кандидатов (`<notes>` редактора): подпись → текст, в `candidates/<подпись>/notes.md`. */
  notes?: Readonly<Record<string, string>>;
  /** Файлы check.mjs задач: ни одна их строка не должна попасть в контекст. */
  checkFiles: readonly string[];
  fingerprints: readonly string[];
}

/** Собрать `context/` и проверить его tripwire'ами. Бросает ошибку при утечке. */
export function buildContext(input: ContextInput): string {
  const dir = input.dir;
  if (existsSync(dir)) throw new Error(`${dir} уже есть: контекст собирается в новую папку`);
  mkdirSync(dir, { recursive: true });
  writeTree(join(dir, "base_harness"), input.base);
  for (const [label, tree] of Object.entries(input.candidates ?? {})) {
    writeTree(join(dir, "candidates", label, "harness"), tree);
  }
  for (const [label, text] of Object.entries(input.notes ?? {})) {
    mkdirSync(join(dir, "candidates", label), { recursive: true });
    writeFileSync(join(dir, "candidates", label, "notes.md"), text);
  }
  for (const [task, prompts] of Object.entries(input.requests)) {
    const t = join(dir, "tasks", task.replace(/\//g, "-"));
    mkdirSync(t, { recursive: true });
    writeFileSync(
      join(t, "request.md"),
      prompts.map((p, i) => `## Message ${i + 1} from the owner\n\n${p}`).join("\n\n"),
    );
  }
  for (const r of input.rollouts) {
    const t = join(dir, "tasks", r.task.replace(/\//g, "-"), r.label);
    mkdirSync(t, { recursive: true });
    writeFileSync(join(t, "transcript.md"), transcript(r.sessionsDir));
    writeFileSync(
      join(t, "files.md"),
      r.workspace ? producedFiles(r.workspace, input.originals[r.task]) : "(no workspace)",
    );
  }
  assertNoLeakPaths(dir);
  assertNoGraderVerdicts(dir);
  assertNoCheckText(dir, input.fingerprints);
  return dir;
}
