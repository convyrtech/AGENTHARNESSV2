// Что изменилось за ход — по файлам, а не по вызовам edit/write: `sed -i`, генераторы и `npm init` тоже правят
// папку. Как «Откатить ход» ядра (main/prsloy/turn-snapshots.ts, дизайн OpenCode): теневой git-репозиторий с
// рабочим деревом = папка проекта; снимок перед ходом (`add -A` + `write-tree`) и в конце, между ними `git diff`.
// Репозиторий свой, в outputDir: снимок ядра идёт под таймаутом 20 с и может лечь уже посреди хода, а хост
// не знает ни его папки, ни git-бинаря. Свой `.git` пользователя не трогаем (git пропускает пути `.git`).
import { type ChildProcess, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { type ExtensionAPI, getShellConfig } from "@earendil-works/pi-coding-agent";

/** Как в ядре: то, что не стоит снимать, даже если проект забыл это игнорировать. */
const BASE_EXCLUDES = [
  "node_modules/",
  ".venv/",
  "venv/",
  "__pycache__/",
  ".pytest_cache/",
  ".mypy_cache/",
  ".next/",
  ".turbo/",
  ".cache/",
  "*.pyc",
  ".DS_Store",
  "Thumbs.db",
];

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 25_000;

export interface TurnDiff {
  /** Пути относительно папки проекта, через `/`. */
  files: string[];
  /** Унифицированный дифф (`git diff -U3`), без цвета. */
  patch: string;
}

function escapeExcludePath(path: string): string {
  return `/${path.replace(/[\\*?[\]!#]/g, (c) => `\\${c}`)}`;
}

/** git для Windows: рядом с Git Bash (PortableGit/bin/bash.exe → PortableGit/cmd/git.exe). */
export function gitNextToShell(shellPath: string | undefined): string | undefined {
  if (!shellPath) return undefined;
  const bin = dirname(shellPath);
  const exe = process.platform === "win32" ? "git.exe" : "git";
  for (const candidate of [
    join(bin, exe),
    join(bin, "..", "cmd", exe),
    join(bin, "..", "bin", exe),
  ])
    if (existsSync(candidate)) return candidate;
  return undefined;
}

export class ShadowGit {
  readonly gitDir: string;
  readonly #workTree: string;
  readonly #git: () => string;

  constructor(root: string, workTree: string, git: () => string) {
    this.#workTree = resolve(workTree);
    const keyed = process.platform === "win32" ? this.#workTree.toLowerCase() : this.#workTree;
    this.gitDir = join(root, createHash("sha256").update(keyed).digest("hex").slice(0, 16), "git");
    this.#git = git;
  }

  /** Живые процессы git этого репозитория: при закрытии сессии гасим, иначе на Windows git.exe держит файлы. */
  readonly #children = new Set<ChildProcess>();
  #stopped = false;

  /** Гасит идущие git и не даёт запустить новые. */
  stop(): void {
    this.#stopped = true;
    for (const child of this.#children) child.kill("SIGKILL");
  }

  #run(args: string[], input?: string): Promise<string> {
    if (this.#stopped) return Promise.reject(new Error("shadow git stopped"));
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env))
      if (!key.toUpperCase().startsWith("GIT_")) env[key] = value;
    env.GIT_DIR = this.gitDir;
    env.GIT_WORK_TREE = this.#workTree;
    env.GIT_CONFIG_NOSYSTEM = "1";
    env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
    env.GIT_TERMINAL_PROMPT = "0";
    env.GIT_OPTIONAL_LOCKS = "0";
    const full = [
      "core.autocrlf=false",
      "core.safecrlf=false",
      "core.longpaths=true",
      "core.quotepath=false",
      "core.fsmonitor=false",
      "gc.auto=0",
      "color.ui=false",
    ].flatMap((c) => ["-c", c]);
    return new Promise((resolvePromise, reject) => {
      const child = execFile(
        this.#git(),
        [...full, ...args],
        {
          cwd: this.#workTree,
          env,
          windowsHide: true,
          maxBuffer: 64 * 1024 * 1024,
          encoding: "utf8",
          // Зависший git (сетевой диск, блокировка) не держит ход дольше двух минут.
          timeout: 120_000,
          killSignal: "SIGKILL",
        },
        (error, stdout, stderr) => {
          this.#children.delete(child);
          if (error) reject(new Error(`git ${args[0]}: ${String(stderr || error.message).trim()}`));
          else resolvePromise(String(stdout));
        },
      );
      this.#children.add(child);
      if (input !== undefined) child.stdin?.end(input);
    });
  }

  /** Снимок папки: хэш дерева или undefined (не git, слишком большая папка, ошибка). Не бросает. */
  async snapshot(): Promise<string | undefined> {
    try {
      if (!(await lstat(this.#workTree)).isDirectory()) return undefined;
      if (!existsSync(join(this.gitDir, "HEAD"))) {
        await mkdir(this.gitDir, { recursive: true });
        await this.#run(["init", "--quiet"]);
      }
      await mkdir(join(this.gitDir, "info"), { recursive: true });
      await writeFile(join(this.gitDir, "info", "exclude"), `${BASE_EXCLUDES.join("\n")}\n`);
      const listed = await this.#run([
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
      ]);
      const candidates = [...new Set(listed.split("\0").filter(Boolean))];
      if (candidates.length > MAX_FILES) return undefined;
      const large: string[] = [];
      for (const path of candidates) {
        try {
          const stat = await lstat(join(this.#workTree, path));
          if (stat.isFile() && stat.size > MAX_FILE_BYTES) large.push(path);
        } catch {
          // удалён после списка: add -A запишет удаление
        }
      }
      if (large.length > 0) {
        await writeFile(
          join(this.gitDir, "info", "exclude"),
          `${[...BASE_EXCLUDES, ...large.map(escapeExcludePath)].join("\n")}\n`,
        );
        await this.#run(
          [
            "rm",
            "--cached",
            "--quiet",
            "--ignore-unmatch",
            "--pathspec-from-file=-",
            "--pathspec-file-nul",
          ],
          `${large.join("\0")}\0`,
        );
      }
      await this.#run(["add", "--all"]);
      return (await this.#run(["write-tree"])).trim() || undefined;
    } catch {
      return undefined;
    }
  }

  /** Дифф между двумя снимками. Не бросает: при ошибке — пустой. */
  async diff(from: string, to: string): Promise<TurnDiff> {
    if (from === to) return { files: [], patch: "" };
    try {
      const names = await this.#run([
        "diff-tree",
        "-r",
        "--no-renames",
        "--name-only",
        "-z",
        from,
        to,
      ]);
      const patch = await this.#run([
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-renames",
        "-U3",
        from,
        to,
      ]);
      return { files: names.split("\0").filter(Boolean), patch };
    } catch {
      return { files: [], patch: "" };
    }
  }
}

/** Ход как пара снимков: начало — перед первым тулом, конец — когда гейт спрашивает. */
export class TurnChanges {
  readonly #root: string;
  readonly #git: () => string;
  #shadow: ShadowGit | undefined;
  #start: Promise<string | undefined> | undefined;
  /** Идущие снимки и диффы: ход не считается законченным, пока они не завершились. */
  readonly #pending = new Set<Promise<unknown>>();

  #track<T>(promise: Promise<T>): Promise<T> {
    this.#pending.add(promise);
    void promise.finally(() => this.#pending.delete(promise));
    return promise;
  }

  /** `root` — где лежат теневые репозитории (по одному на папку проекта). */
  constructor(root: string, git: () => string) {
    this.#root = root;
    this.#git = git;
  }

  /** Новое сообщение пользователя: снимаем папку, не задерживая первый запрос к модели. */
  begin(cwd: string): void {
    this.#shadow = new ShadowGit(this.#root, cwd, this.#git);
    this.#start = this.#track(this.#shadow.snapshot());
  }

  /** Дождаться всех git этого хода (конец хода, в том числе с ошибкой или «стопом»). */
  async idle(): Promise<void> {
    while (this.#pending.size > 0) await Promise.allSettled(this.#pending);
  }

  /** Закрытие сессии: гасим идущий git и ждём, пока процессы выйдут. */
  async dispose(): Promise<void> {
    this.#shadow?.stop();
    await this.idle();
  }

  /** Тулы, которые могут менять файлы, ждут снимка начала (не дольше `timeoutMs`). */
  async ready(timeoutMs = 30_000): Promise<void> {
    if (!this.#start) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.#start,
      new Promise((r) => {
        timer = setTimeout(r, timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  /** Что изменилось с начала хода. undefined — снимков нет (не знаем, а не «ничего»). */
  async current(): Promise<TurnDiff | undefined> {
    const start = await this.#start;
    if (!start || !this.#shadow) return undefined;
    const shadow = this.#shadow;
    const end = await this.#track(shadow.snapshot());
    if (!end) return undefined;
    return this.#track(shadow.diff(start, end));
  }
}

/** Тулы, которые точно не меняют файлы: им снимок начала хода ждать незачем. */
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls", "find_ready", "process"]);

/**
 * Снимок в начале каждого сообщения пользователя. Ставится первым: обработчик tool_call ждёт снимка до того,
 * как bash (и реестр фоновых процессов) что-то запустит.
 */
export function installTurnChanges(pi: ExtensionAPI, changes: TurnChanges): void {
  pi.on("before_agent_start", (event, ctx) => {
    if (event.messageType === "user") changes.begin(ctx.cwd);
  });
  pi.on("tool_call", async (event) => {
    if (!READ_ONLY_TOOLS.has(event.toolName)) await changes.ready();
    return undefined;
  });
  // Ход кончился как угодно (готово, ошибка, обрыв, «стоп»): снимок начала не должен писать после него.
  pi.on("agent_settled", async () => {
    await changes.idle();
  });
  pi.on("session_shutdown", async () => {
    await changes.dispose();
  });
}

/**
 * git для снимков: явный путь, иначе на Windows — рядом с Git Bash, которым Pi запускает bash, иначе `git` с PATH.
 * Ищем на каждом снимке: PortableGit распаковывается уже после старта хоста.
 */
export function gitResolver(pi: ExtensionAPI, explicit: string | undefined): () => string {
  return () => {
    if (explicit) return explicit;
    if (process.platform === "win32") {
      try {
        const nearShell = gitNextToShell(getShellConfig(pi.getSettings().shellPath).shell);
        if (nearShell) return nearShell;
      } catch {
        // bash не найден — git с PATH
      }
    }
    return "git";
  };
}
