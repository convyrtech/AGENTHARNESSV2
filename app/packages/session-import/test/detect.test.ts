import { afterEach, describe, expect, it } from "vite-plus/test";
import { utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { candidateKey, scanSources } from "../src/detect.ts";
import { emptyLedger } from "../src/ledger.ts";
import { cleanTemp, CODEX_ID, fakeMachine } from "./helpers.ts";

afterEach(cleanTemp);

const NOW = Date.UTC(2026, 9, 25);

describe("scanSources", () => {
  it("counts chats and projects per tool and ticks recent ones", async () => {
    const machine = await fakeMachine();
    const result = await scanSources({ roots: machine.roots, ledger: emptyLedger(), now: NOW });
    expect(result.counts).toEqual({
      // basic, branches, broken (continued is not offered; the subagent log is not a chat)
      "claude-code": { chats: 3, projects: 1, recent: 3 },
      codex: { chats: 1, projects: 1, recent: 1 },
      "pi-cli": { chats: 1, projects: 1, recent: 1 },
      opencode: { chats: 0, projects: 0, recent: 0 },
      gemini: { chats: 0, projects: 0, recent: 0 },
      "cursor-agent": { chats: 0, projects: 0, recent: 0 },
      cline: { chats: 0, projects: 0, recent: 0 },
      "roo-code": { chats: 0, projects: 0, recent: 0 },
      "kilo-code": { chats: 0, projects: 0, recent: 0 },
    });
    expect(result.skipped).toEqual([]);
    expect(result.selected).toHaveLength(5);
    expect(result.candidates.find((c) => c.tool === "codex")?.sourcePath).toContain("2026/10/02");
    expect(result.candidates.map((c) => c.updatedAt)).toEqual(
      result.candidates.map((c) => c.updatedAt).sort((a, b) => b - a),
    );
  });

  it("leaves out old chats, already imported ones, and stops at the limit", async () => {
    const machine = await fakeMachine();
    const first = await scanSources({ roots: machine.roots, ledger: emptyLedger(), now: NOW });
    const codex = first.candidates.find((c) => c.tool === "codex")!;
    const ledger = {
      version: 1 as const,
      entries: [
        {
          tool: codex.tool,
          sourceId: codex.sourceId,
          sourcePath: codex.sourcePath,
          size: codex.size,
          mtimeMs: codex.mtimeMs,
          sha256: "x",
          piSession: "/s.jsonl",
          importedAt: "",
        },
      ],
    };
    const later = await scanSources({
      roots: machine.roots,
      ledger,
      now: Date.UTC(2026, 11, 1), // two months on: the Claude chats (Oct 1) are old
      limit: 1,
    });
    expect(later.candidates.find((c) => c.tool === "codex")?.alreadyImported).toBe(true);
    expect(later.selected).not.toContain(candidateKey({ tool: "codex", sourceId: CODEX_ID }));
    expect(later.counts["claude-code"].recent).toBe(0);
    expect(later.selected.length).toBeLessThanOrEqual(1);
  });

  it("finds nothing on a machine without other agents, and survives an unreadable file", async () => {
    const machine = await fakeMachine();
    const empty = await scanSources({
      roots: {
        claudeProjects: "/нет/1",
        codexHome: "/нет/2",
        piSessions: "/нет/3",
        opencodeData: "/нет/4",
        geminiDir: "/нет/5",
        cursorDir: "/нет/6",
        editorData: "/нет/7",
        clineData: "/нет/8",
      },
      ledger: emptyLedger(),
    });
    expect(empty.candidates).toEqual([]);
    expect(empty.selected).toEqual([]);
    const junk = join(machine.roots.piSessions, "мусор.jsonl");
    await writeFile(junk, "\u0000\u0001 не json");
    await utimes(junk, new Date(NOW), new Date(NOW));
    const result = await scanSources({ roots: machine.roots, ledger: emptyLedger(), now: NOW });
    expect(result.counts["pi-cli"].chats).toBe(1);
  });
});
