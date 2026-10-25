/**
 * After «Откатить ход» the host appends a pi custom message (session.note). The model must
 * see it on the next turn — as context, not as a fake user turn of its own.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createPixRuntime } from "@zeno/agent-runtime";
import { FakeOpenAiServer } from "../../../../packages/test-utils/src/index.ts";
import { undoNoteText, UNDO_NOTE_CUSTOM_TYPE } from "../main/prsloy/ipc.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

describe("undo note reaches the model", () => {
  it("is in the next request's context and persisted in the session", async () => {
    const root = mkdtempSync(join(tmpdir(), "prsloy-undo-note-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const agentDir = join(root, "agent");
    const project = join(root, "project");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(project, { recursive: true });
    const server = new FakeOpenAiServer({ toolPath: join(project, "x.txt") });
    await server.start();
    cleanups.push(() => server.stop());
    writeFileSync(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          fake: {
            baseUrl: server.baseUrl,
            apiKey: "k",
            api: "openai-completions",
            models: [
              {
                id: "m",
                name: "m",
                reasoning: false,
                input: ["text"],
                contextWindow: 8192,
                maxTokens: 1024,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      }),
    );
    const handle = await createPixRuntime({
      cwd: project,
      agentDir,
      model: { provider: "fake", id: "m" },
      tools: ["read"],
    });
    cleanups.push(() => handle.dispose());

    await handle.runtime.session.prompt("создай hello.py");
    const note = undoNoteText({ restoredTo: { turn: 1 }, removed: ["hello.py"], rewritten: [] });
    // Same call agent-host/index.ts makes for `session.note`.
    await handle.runtime.session.sendCustomMessage(
      { customType: UNDO_NOTE_CUSTOM_TYPE, content: note, display: true },
      { triggerTurn: false },
    );
    await handle.runtime.session.prompt("что дальше?");

    const last = server.requests.at(-1)!.messages ?? [];
    const texts = last.map((m) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    );
    const noteIndex = texts.findIndex(
      (t) => t.includes("Файлы хода 1 откатены") && t.includes("hello.py"),
    );
    const promptIndex = texts.findIndex((t) => t.includes("что дальше?"));
    expect(noteIndex).toBeGreaterThan(0);
    expect(promptIndex).toBeGreaterThan(noteIndex);
    expect(
      handle.runtime.session.sessionManager
        .getEntries()
        .some(
          (e) =>
            e.type === "custom_message" &&
            (e as { customType?: string }).customType === "prsloy.undo",
        ),
    ).toBe(true);
  });
});
