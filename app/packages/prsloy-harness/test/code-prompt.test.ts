// research/17 §10.3: снапшот, размер, без даты, правила edits[] Pi не изменились, дельты выключены.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { MODEL_DELTAS, modelDelta, PRSLOY_CODE_PROMPT } from "../src/code-prompt.ts";

const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);

describe("PRSLOY code prompt (research/17 §9)", () => {
  it("snapshot: the text is exactly §9 of the research (and the fixture)", () => {
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
    expect(PRSLOY_CODE_PROMPT).toBe(block);
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
