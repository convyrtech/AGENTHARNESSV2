// research/17 §10.3: снапшот, размер, без даты, правила edits[] Pi не изменились, дельты выключены.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import {
  MODEL_DELTAS,
  modelDelta,
  PROMPT_ADDITIONS,
  PRSLOY_CODE_PROMPT,
  RESEARCH_CODE_PROMPT,
} from "../src/code-prompt.ts";

const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);

describe("PRSLOY code prompt (research/17 §9)", () => {
  it("snapshot: §9 of the research verbatim plus the listed additions (and the fixture)", () => {
    expect(PRSLOY_CODE_PROMPT).toBe(readFileSync(fixture("code-prompt.expected.txt"), "utf8"));
    const doc = readFileSync(
      new URL("../../../../research/17-system-prompts.md", import.meta.url),
      "utf8",
    );
    const section = doc.slice(doc.indexOf("## 9. Черновик промпта"));
    const block = section.slice(
      section.indexOf("```text\n") + 8,
      section.indexOf("\n```", section.indexOf("```text\n")),
    );
    expect(RESEARCH_CODE_PROMPT).toBe(block);
    // Без добавленных строк — ровно §9; каждая добавка стоит сразу после своей строки.
    const lines = PRSLOY_CODE_PROMPT.split("\n");
    for (const [anchor, line] of PROMPT_ADDITIONS)
      expect(lines[lines.indexOf(line) - 1]!.startsWith(anchor), line).toBe(true);
    const added = new Set(PROMPT_ADDITIONS.map(([, line]) => line));
    expect(lines.filter((l) => !added.has(l)).join("\n")).toBe(block);
  });

  it("additions: relative paths, request_secret and ask_user, what you chose, <prsloy-next>", () => {
    expect(PRSLOY_CODE_PROMPT).toContain(
      "never `/assets/…`) so the page also works when opened as a file.",
    );
    expect(PRSLOY_CODE_PROMPT).toContain(
      "use the request_secret tool, never ask for it in the chat",
    );
    expect(PRSLOY_CODE_PROMPT).toContain(
      "If you chose for the user (what to build, prices, names, texts), say so in one line.",
    );
    // Кнопки «что дальше»: тег разбирает renderer/lib/next-steps.ts (строки ≤120 символов).
    expect(
      PRSLOY_CODE_PROMPT.endsWith(
        "end with a <prsloy-next>…</prsloy-next> block: 2–3 next steps in Russian, one per line, ≤120 chars.",
      ),
    ).toBe(true);
  });

  it("≤7 500 characters, no date or time, no ripgrep instruction, Russian answers rule", () => {
    expect(PRSLOY_CODE_PROMPT.length).toBeLessThanOrEqual(7500);
    expect(PRSLOY_CODE_PROMPT).not.toMatch(
      /\b20\d\d-\d\d-\d\d\b|\b\d{1,2}:\d\d\b|today is|сегодня/i,
    );
    expect(PRSLOY_CODE_PROMPT).not.toMatch(/Use bash for file operations like ls, rg/);
    expect(PRSLOY_CODE_PROMPT).toContain("Always answer in Russian");
  });

  it("Pi's edits[] rules did not change (our prompt carries them in its own words)", async () => {
    // Подпуть не экспортирован пакетом — берём файл через ссылку pnpm в node_modules пакета.
    const file = new URL(
      "../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/edit.js",
      import.meta.url,
    );
    const edit = (await import(file.href)) as {
      editToolSystemPromptContribution: { guidelines: string[] };
    };
    expect(edit.editToolSystemPromptContribution.guidelines).toEqual(
      JSON.parse(readFileSync(fixture("pi-edit-guidelines.json"), "utf8")),
    );
    expect(PRSLOY_CODE_PROMPT).toContain(
      "each edits[].oldText must match the file exactly and be unique; put all changes to one file into one edit call; do not overlap them",
    );
  });

  it("model deltas exist for qwen and opus only", () => {
    expect(modelDelta("qwen3.8-max")).toBe(MODEL_DELTAS.qwen);
    expect(modelDelta("claude-opus-5-5")).toBe(MODEL_DELTAS.opus);
    expect(modelDelta("deepseek-v4.1-flash-1017")).toBeUndefined();
    expect(modelDelta("kimi-k3.1-pro")).toBeUndefined();
    expect(MODEL_DELTAS.qwen.startsWith("# Qwen (qwen3.8-max)\nModel note:")).toBe(true);
  });
});
