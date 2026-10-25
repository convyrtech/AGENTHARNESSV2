import { afterEach, describe, expect, it } from "vite-plus/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cursorCandidate,
  cursorTranscripts,
  decodeCursorProject,
  MAX_PROJECT_PROBES,
  readCursorChat,
  unwrapUserQuery,
} from "../src/adapters/cursor-agent.ts";
import { scanSources } from "../src/detect.ts";
import { emptyLedger } from "../src/ledger.ts";
import { importChats } from "../src/run.ts";
import { cleanTemp, FIXTURES, fakeMachine } from "./helpers.ts";

afterEach(cleanTemp);

const CURSOR = join(FIXTURES, "cursor", ".cursor");
const SITE = "C:\\Users\\Пётр\\Проекты\\сайт-пекарни";
const winDirs = (...dirs: string[]) => {
  const set = new Set(dirs.map((d) => d.toLowerCase()));
  return (path: string) => set.has(path.toLowerCase());
};

describe("Cursor Agent adapter", () => {
  it("decodes a Windows project folder when exactly one existing folder fits", () => {
    const options = { platform: "win32" as const, isDir: winDirs(SITE) };
    expect(decodeCursorProject("c-Users-Пётр-Проекты-сайт-пекарни", options)).toBe(SITE);
    // a name with a space and a merged parent: «Мои документы»
    const deep = "C:\\Users\\Пётр\\Мои документы\\бот";
    expect(
      decodeCursorProject("c-Users-Пётр-Мои-документы-бот", {
        platform: "win32",
        isDir: winDirs("C:\\Users\\Пётр\\Мои документы", deep),
      }),
    ).toBe(deep);
    // nothing on disk, or two different folders fit: no guess
    expect(
      decodeCursorProject("c-Users-Пётр-Проекты-сайт-пекарни", {
        platform: "win32",
        isDir: () => false,
      }),
    ).toBeUndefined();
    expect(
      decodeCursorProject("c-Users-Пётр-Проекты-сайт-пекарни", {
        platform: "win32",
        isDir: winDirs(SITE, "C:\\Users\\Пётр\\Проекты\\сайт_пекарни"),
      }),
    ).toBeUndefined();
    expect(
      decodeCursorProject("Users-x", { platform: "win32", isDir: () => true }),
    ).toBeUndefined();
  });

  it("decodes a POSIX folder and stops at the probe limit", () => {
    expect(
      decodeCursorProject("-home-petr-moy-sayt", {
        platform: "linux",
        isDir: (p) => p === "/home/petr/moy-sayt",
      }),
    ).toBe("/home/petr/moy-sayt");
    let probes = 0;
    const counting = (path: string) => {
      probes += 1;
      return path === "never";
    };
    const long = Array.from({ length: 60 }, (_, i) => `p${i}`).join("-");
    expect(decodeCursorProject(long, { platform: "linux", isDir: counting })).toBeUndefined();
    expect(probes).toBeLessThanOrEqual(MAX_PROJECT_PROBES);
    expect(
      decodeCursorProject("home-..-etc", { platform: "linux", isDir: () => true }),
    ).toBeUndefined();
  });

  it("takes the person's words out of Cursor's wrapper", () => {
    expect(
      unwrapUserQuery("<timestamp>Friday</timestamp>\n<user_query>\nСделай меню\n</user_query>"),
    ).toBe("Сделай меню");
    expect(unwrapUserQuery("<cursor_commands>x</cursor_commands><user_query>а</user_query>")).toBe(
      "а",
    );
    expect(unwrapUserQuery("<user_query>а</user_query> хвост")).toBe(
      "<user_query>а</user_query> хвост",
    );
    expect(unwrapUserQuery("просто текст")).toBe("просто текст");
  });

  it("finds transcripts, nested ones too, without subagents and projectless chats", () => {
    const found = cursorTranscripts({ cursorDir: CURSOR });
    expect(found).toHaveLength(2);
    expect(found.every((f) => f.encodedProject === "c-Users-Пётр-Проекты-сайт-пекарни")).toBe(true);
    expect(cursorTranscripts({ cursorDir: join(CURSOR, "нет") })).toEqual([]);
  });

  it("brings over text and tool notes; tool results, thinking and service lines are left", async () => {
    const first = cursorTranscripts({ cursorDir: CURSOR }).find((f) => f.path.includes("2c4e6a8b"));
    const chat = await readCursorChat(first!.path, SITE);
    expect(chat?.turns.map((t) => [t.role, t.text])).toEqual([
      ["user", "Сделай меню на сайте"],
      ["assistant", `Добавляю меню.\n• Edit: ${SITE}\\index.html\nМеню готово.`],
      ["user", "Спасибо"],
    ]);
    expect(chat?.title).toBe("Сделай меню на сайте");
    expect(chat?.dropped).toMatchObject({
      thinking: 1,
      toolResults: 1,
      service: 1,
      brokenLines: 1,
    });
    // on this machine the Windows folder does not exist: the candidate has no project
    expect(await cursorCandidate(first!)).toBeUndefined();
  });

  it("goes through scan and run when a line names the project folder", async () => {
    const machine = await fakeMachine();
    const dir = join(machine.roots.cursorDir, "projects", "something-lossy", "agent-transcripts");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "6a8c0e2f.jsonl"),
      [
        {
          role: "user",
          cwd: machine.projects.claude,
          timestamp: "2026-10-24T10:00:00.000Z",
          message: { content: "<user_query>Сделай корзину</user_query>" },
        },
        {
          role: "assistant",
          timestamp: "2026-10-24T10:01:00.000Z",
          message: { content: "Готово." },
        },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n"),
    );
    const scan = await scanSources({
      roots: machine.roots,
      ledger: emptyLedger(),
      now: Date.UTC(2026, 9, 25),
    });
    const cursor = scan.candidates.filter((c) => c.tool === "cursor-agent");
    expect(cursor.map((c) => c.title)).toEqual(["Сделай корзину"]);
    const [result] = await importChats({
      candidates: cursor,
      roots: machine.roots,
      home: machine.home,
      sessionDir: machine.sessionDir,
      ledgerPath: machine.ledgerPath,
      target: { provider: "prsloy", modelId: "m" },
    });
    expect(result).toMatchObject({ status: "imported", title: "Сделай корзину" });
  });
});
