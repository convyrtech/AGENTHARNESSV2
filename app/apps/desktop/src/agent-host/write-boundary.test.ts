import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { classifyBash, classifyFileWrite, type BoundaryEnv } from "./write-boundary-rules.ts";
import { ANSWER_NO, ANSWER_SESSION, ANSWER_YES, createWriteBoundary } from "./write-boundary.ts";

// Not under os.tmpdir(): that one is an allowed root.
const base = mkdtempSync(join(process.cwd(), ".wb-test-"));
const project = join(base, "проект");
const outside = join(base, "elsewhere");
mkdirSync(join(project, "src"), { recursive: true });
mkdirSync(outside, { recursive: true });
afterAll(() => rmSync(base, { recursive: true, force: true }));

const env: BoundaryEnv = { cwd: project, allowedRoots: [project, tmpdir()], home: base };
const asks = (command: string) => classifyBash(command, env).ask;

describe("write / edit", () => {
  it("inside the project: no question; outside: the Russian question with the path", () => {
    expect(classifyFileWrite("src/app.ts", env).ask).toBe(false);
    expect(classifyFileWrite(join(project, "a.txt"), env).ask).toBe(false);
    expect(classifyFileWrite(join(tmpdir(), "scratch.txt"), env).ask).toBe(false);
    const verdict = classifyFileWrite("../elsewhere/x.txt", env);
    expect(verdict).toMatchObject({ ask: true });
    if (verdict.ask) {
      expect(verdict.question).toBe(
        `Агент хочет изменить файл вне проекта: ${join(outside, "x.txt")}. Разрешить?`,
      );
    }
    expect(classifyFileWrite("~/.bashrc", env).ask).toBe(true);
  });

  it("a symlink inside the project that points outside counts as outside", () => {
    symlinkSync(outside, join(project, "link"));
    expect(classifyFileWrite("link/x.txt", env).ask).toBe(true);
  });

  it("Windows: Git Bash paths and case-insensitive roots", () => {
    const win: BoundaryEnv = {
      cwd: "C:\\Users\\Иван\\proj",
      allowedRoots: ["C:\\Users\\Иван\\proj"],
      platform: "win32",
      home: "C:\\Users\\Иван",
    };
    expect(classifyFileWrite("c:\\users\\иван\\PROJ\\a.txt", win).ask).toBe(false);
    expect(classifyFileWrite("/c/Users/Иван/proj/b.txt", win).ask).toBe(false);
    expect(classifyFileWrite("/c/Windows/System32/x.dll", win).ask).toBe(true);
    expect(classifyFileWrite("D:\\data.txt", win).ask).toBe(true);
  });
});

describe("bash", () => {
  it("ordinary work inside the project is never asked about", () => {
    for (const command of [
      "ls -la && cat src/app.ts | grep foo",
      "rm -rf node_modules dist",
      "rm src/*.log",
      "mv src/a.ts src/b.ts",
      "npm install && npm run build > build.log 2>&1",
      "python3 -m http.server 8000 &",
      "git push origin main",
      "echo hi > /dev/null",
      `rm -rf ${join(tmpdir(), "cache")}`,
      "find . -name '*.tmp' -delete",
      "cd src && rm old.ts",
    ]) {
      expect(asks(command), command).toBe(false);
    }
  });

  it("deleting or moving outside the project is asked about", () => {
    for (const command of [
      "rm -rf /",
      "rm -rf ~",
      "rm -rf $HOME/Documents",
      `rm -rf ${outside}`,
      "rm -rf ../elsewhere",
      "cd .. && rm -rf elsewhere",
      `mv src/app.ts ${outside}/`,
      `find ${outside} -name '*.log' -delete`,
      "del /s /q C:\\Users\\me\\Documents",
      "Remove-Item -Recurse -Force C:\\Users\\me",
      "Remove-Item -Path ..\\elsewhere -Recurse",
      `sudo rm -rf ${outside}`,
      `bash -c "rm -rf ${outside}"`,
      `echo data > ${outside}/x.txt`,
    ]) {
      expect(asks(command), command).toBe(true);
    }
  });

  it("system-level and git force operations are always asked about", () => {
    for (const command of [
      "format D: /q",
      "reg add HKCU\\Software\\X /v Y /d 1",
      "reg delete HKLM\\Software\\X /f",
      "git push --force origin main",
      "git push -f",
      "git push origin +main",
      "git push --force-with-lease",
      "dd if=/dev/zero of=/dev/sda",
      "mkfs.ext4 /dev/sdb1",
    ]) {
      expect(asks(command), command).toBe(true);
    }
    expect(asks("reg query HKCU\\Software")).toBe(false);
  });

  it("when unsure, it asks: variables, substitution, xargs, broken quoting", () => {
    for (const command of [
      "rm -rf $TARGET",
      "rm -rf $(cat list.txt)",
      "ls | xargs rm",
      "rm -rf 'unterminated",
      "cd $DIR && rm -rf build",
    ]) {
      expect(asks(command), command).toBe(true);
    }
  });
});

describe("the extension: answers and memory", () => {
  type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
  function setup() {
    let handler: Handler | undefined;
    const pi = { on: (_name: string, h: Handler) => (handler = h) };
    createWriteBoundary()(pi as never);
    const questions: string[] = [];
    const answers: (string | undefined)[] = [];
    const call = (input: Record<string, unknown>, session = "s1", toolName = "write") =>
      handler!(
        { toolName, input },
        {
          cwd: project,
          hasUI: true,
          sessionManager: { getSessionId: () => session },
          ui: {
            select: async (question: string) => {
              questions.push(question);
              return answers.shift();
            },
          },
        },
      );
    return { call, questions, answers };
  }

  it("inside the project: no dialog at all", async () => {
    const { call, questions } = setup();
    expect(await call({ path: "src/a.ts" })).toBeUndefined();
    expect(questions).toEqual([]);
  });

  it("«Да» allows once, the next one asks again", async () => {
    const { call, questions, answers } = setup();
    answers.push(ANSWER_YES, ANSWER_YES);
    expect(await call({ path: join(outside, "a") })).toBeUndefined();
    expect(await call({ path: join(outside, "b") })).toBeUndefined();
    expect(questions).toHaveLength(2);
  });

  it("«Нет» blocks, and the same action stays refused without asking again", async () => {
    const { call, questions, answers } = setup();
    answers.push(ANSWER_NO);
    expect(await call({ path: join(outside, "a") })).toMatchObject({ block: true });
    expect(await call({ path: join(outside, "a") })).toMatchObject({ block: true });
    expect(questions).toHaveLength(1);
  });

  it("closing the dialog is a refusal", async () => {
    const { call, answers } = setup();
    answers.push(undefined);
    expect(await call({ command: `rm -rf ${outside}` }, "s1", "bash")).toMatchObject({
      block: true,
    });
  });

  it("«Разрешать в этом разговоре» is remembered for this session only", async () => {
    const { call, questions, answers } = setup();
    answers.push(ANSWER_SESSION, ANSWER_NO);
    expect(await call({ path: join(outside, "a") }, "s1")).toBeUndefined();
    expect(await call({ command: `rm -rf ${outside}` }, "s1", "bash")).toBeUndefined();
    expect(questions).toHaveLength(1);
    // Another conversation asks again.
    expect(await call({ path: join(outside, "a") }, "s2")).toMatchObject({ block: true });
    expect(questions).toHaveLength(2);
  });

  it("without a UI it blocks instead of guessing", async () => {
    let handler: Handler | undefined;
    createWriteBoundary()({ on: (_n: string, h: Handler) => (handler = h) } as never);
    const result = await handler!(
      { toolName: "write", input: { path: join(outside, "a") } },
      { cwd: project, hasUI: false, sessionManager: { getSessionId: () => "s" } },
    );
    expect(result).toMatchObject({ block: true });
  });
});
