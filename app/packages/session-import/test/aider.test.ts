/**
 * Aider: a synthetic `.aider.chat.history.md` written here (never a real one), in a project
 * folder with a Cyrillic name. Two sessions in one file, Aider's own output, an edit block.
 */
import { afterEach, describe, expect, it } from "vite-plus/test";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AIDER_HISTORY,
  aiderCandidates,
  aiderReply,
  readAiderChat,
} from "../src/adapters/aider.ts";
import { scanSources } from "../src/detect.ts";
import { emptyLedger, readLedger } from "../src/ledger.ts";
import { importChats } from "../src/run.ts";
import { cleanTemp, fakeMachine, tempDir } from "./helpers.ts";

afterEach(cleanTemp);

const HISTORY = `
# aider chat started at 2026-10-20 10:00:00

> Add .aider* to .gitignore (recommended)? (Y)es/(N)o [Yes]: y
> /usr/bin/aider --model deepseek
> Aider v0.86.0

#### сделай лендинг для пекарни
#### с меню и контактами

Сделаю страницу.

index.html
\`\`\`html
<<<<<<< SEARCH
=======
<html><body>Пекарня</body></html>
>>>>>>> REPLACE
\`\`\`

Готово, проверьте в браузере.

> Applied edit to index.html
> Commit 1a2b3c4 feat: landing
> Tokens: 2.1k sent, 300 received.

#### поменяй фон, ключ API_KEY=abcdefgh12345678

Фон бежевый.

# aider chat started at 2026-10-22 18:30:00

> Aider v0.86.0

#### /add style.css

> Added style.css to the chat

#### сделай шрифт крупнее

\`\`\`css
body { font-size: 18px; }
\`\`\`
`;

async function project(dir: string) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, AIDER_HISTORY), HISTORY);
}

describe("Aider adapter", () => {
  it("turns SEARCH/REPLACE edit blocks into notes and keeps other code", () => {
    const files = new Set<string>();
    expect(
      aiderReply(
        "Делаю.\n\nа.html\n```html\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n```\n\nГотово.",
        files,
      ),
    ).toBe("Делаю.\n• Edit: а.html\nГотово.");
    expect([...files]).toEqual(["а.html"]);
    expect(aiderReply("```css\nbody {}\n```", new Set())).toBe("```css\nbody {}\n```");
  });

  it("offers each session of the file as its own chat", async () => {
    const dir = join(await tempDir(), "Проекты", "пекарня");
    await project(dir);
    const candidates = aiderCandidates(dir);
    expect(candidates.map((c) => [c.title, c.cwd])).toEqual([
      ["сделай лендинг для пекарни", dir],
      ["/add style.css", dir],
    ]);
    expect(candidates[0]!.fingerprint).toMatch(/^aider:2026-10-20 10:00:00:\d+$/u);
    expect(aiderCandidates(join(dir, "нет"))).toEqual([]);
  });

  it("reads a session: requests, replies with edit notes; Aider's output left", async () => {
    const dir = join(await tempDir(), "Проекты", "пекарня");
    await project(dir);
    const [first] = aiderCandidates(dir);
    const chat = readAiderChat(first!.sourcePath, first!.sourceId, dir);
    expect(chat?.turns.map((t) => [t.role, t.text])).toEqual([
      ["user", "сделай лендинг для пекарни\nс меню и контактами"],
      ["assistant", "Сделаю страницу.\n• Edit: index.html\nГотово, проверьте в браузере."],
      ["user", "поменяй фон, ключ API_KEY=[СКРЫТО: секрет]"],
      ["assistant", "Фон бежевый."],
    ]);
    expect(chat?.files).toEqual(["index.html"]);
    expect(chat?.dropped.service).toBe(6);
    expect(chat?.secrets).toBe(1);
  });

  it("finds Aider history in project folders other chats point to, and re-offers a session that grew", async () => {
    const machine = await fakeMachine();
    await project(machine.projects.claude);
    const now = Date.UTC(2026, 9, 25);
    const scan = await scanSources({ roots: machine.roots, ledger: emptyLedger(), now });
    const aider = scan.candidates.filter((c) => c.tool === "aider");
    expect(aider).toHaveLength(2);
    const options = {
      roots: machine.roots,
      home: machine.home,
      sessionDir: machine.sessionDir,
      ledgerPath: machine.ledgerPath,
      target: { provider: "prsloy", modelId: "m" },
    };
    expect((await importChats({ ...options, candidates: aider })).map((r) => r.status)).toEqual([
      "imported",
      "imported",
    ]);
    // the later session goes on; the first stays as it was
    await appendFile(
      join(machine.projects.claude, AIDER_HISTORY),
      "\n#### и ещё кнопку\n\nДобавил.\n",
    );
    const again = await scanSources({
      roots: machine.roots,
      ledger: await readLedger(machine.ledgerPath),
      now,
    });
    const states = again.candidates
      .filter((c) => c.tool === "aider")
      .map((c) => [c.title, c.alreadyImported ?? false]);
    expect(states).toEqual(
      expect.arrayContaining([
        ["сделай лендинг для пекарни", true],
        ["/add style.css", false],
      ]),
    );
    // a folder named by the caller, too
    const extra = join(machine.root, "Проекты", "отдельный");
    await project(extra);
    const withExtra = await scanSources({
      roots: machine.roots,
      ledger: emptyLedger(),
      now,
      extraProjects: [extra],
    });
    expect(withExtra.candidates.filter((c) => c.tool === "aider" && c.cwd === extra)).toHaveLength(
      2,
    );
  });
});
