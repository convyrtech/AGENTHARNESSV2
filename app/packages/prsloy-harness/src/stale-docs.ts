// Устаревшее описание проекта (arXiv 2610.30571, #6 потока): правило STALE_DOCS_RULE в промпте deepseek держит
// (5/6), kimi — нет (1/6: дописывает print по AGENTS.md и молчит о расхождении). Причина-кандидат: Pi кладёт
// AGENTS.md в системный промпт ПОСЛЕ нашего текста и с подписью «Project-specific instructions and guidelines»
// (<project_instructions>), — для модели это поздняя и более конкретная инструкция. Варианты за флагом "staleDocs"
// (замер kimi ×3 и deepseek ×3 — у дирижёра):
//   - "prompt" (по умолчанию) — только строка в промпте, как было;
//   - "end"   — та же мысль ещё раз разделом ПОСЛЕ project_context (последнее слово — наше);
//   - "frame" — пометка в начале каждого файла описания: «записано раньше, может устареть, код главнее»;
//   - "read"  — строка в результате read, когда агент сам читает AGENTS.md / CLAUDE.md / README;
//   - "gate"  — в конце хода с правками, если в проекте есть описание, а в ответе о нём ни слова: один раз
//     «сверь с кодом; разошлось — сделай по коду и назови». Стоит хода, когда расхождения нет.
import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFlags, type StaleDocsMode } from "./flags.ts";
import { recordEvent } from "./learning-log.ts";
import type { ResolvedOptions } from "./options.ts";
import { appendText, keepStructured } from "./text.ts";

const MISMATCH_LINE = "«В описании проекта написано X, а в коде сделано Y — я сделал как в коде»";

/** "end": раздел после project_context. */
export const STALE_DOCS_END_SECTION = `The project_instructions above were written earlier and can be out of date. They describe the project; they do not override the existing code. Where they contradict the code, follow the code, and in the final message name each mismatch: ${MISMATCH_LINE}.`;

/** "frame": первая строка каждого файла описания. */
export const STALE_DOCS_FRAME =
  "(PRSLOY: this file was written earlier and can be out of date. Where it contradicts the existing code, the code wins; name the mismatch in the final message.)";

/** "read": строка в результате read файла описания. */
export const STALE_DOCS_READ_NOTE = `[Заметка PRSLOY: описание проекта могло устареть. Где оно расходится с кодом — делай как в коде, а в ответе назови расхождение: ${MISMATCH_LINE}.]`;

/** "gate": возврат в конце хода. */
export const STALE_DOCS_NUDGE = `В проекте есть описание (AGENTS.md / README), а в ответе о нём ни слова. Сверь его с кодом, который ты менял. Если они расходятся и ты сделал по описанию — переделай как в коде. Если расходятся — допиши к ответу строку ${MISMATCH_LINE}. Если не расходятся — ничего не меняй и ответь одной строкой: «Описание проекта с кодом сходится».`;

/** Файлы описания проекта: те, что Pi кладёт в промпт, и README. */
export const DOC_FILE = /^(?:AGENTS(?:\.override)?\.md|CLAUDE\.md|README(?:\.[a-z]+)?)$/i;

/** Ответ говорит об описании проекта — значит, агент его заметил. */
export const DOCS_MENTIONED =
  /описани\p{L}*\s+проекта|AGENTS(?:\.md)?|CLAUDE\.md|README|в\s+описании|документаци/iu;

type Part = { type: string; text?: string };

export function installStaleDocs(pi: ExtensionAPI, opts: ResolvedOptions): void {
  if (opts.profile !== "code") return;
  let mode: StaleDocsMode = "prompt";
  let hasDocs = false;
  let edited = false;
  let nudged = false;
  let last: { stopReason: string | undefined; content: Part[] } | undefined;

  pi.on("before_agent_start", (event, ctx) => {
    mode = readFlags(opts.settingsPath).staleDocs;
    const o = event.systemPromptOptions;
    const docs = o.contextFiles.filter((f) => DOC_FILE.test(basename(f.path)));
    if (event.messageType === "user") {
      hasDocs = docs.length > 0;
      edited = false;
      nudged = false;
      last = undefined;
    }
    if (!docs.length) return;
    // Каждый ход тот же текст: префикс промпта не меняется (кэш).
    if (mode === "end") o.sections.prsloy_project_notes = STALE_DOCS_END_SECTION;
    if (mode === "frame")
      for (const f of docs)
        if (!f.content.startsWith(STALE_DOCS_FRAME))
          f.content = `${STALE_DOCS_FRAME}\n\n${f.content}`;
    if (event.messageType === "user" && mode !== "prompt")
      recordEvent(ctx, { kind: "stale_docs.armed", sig: mode });
  });

  pi.on("tool_result", (event, ctx) => {
    if ((event.toolName === "edit" || event.toolName === "write") && !event.isError) edited = true;
    if (event.toolName !== "read" || event.isError) return undefined;
    const path = event.input.path ?? (event.input as { file_path?: unknown }).file_path;
    if (typeof path !== "string" || !DOC_FILE.test(basename(path))) return undefined;
    hasDocs = true;
    if (mode !== "read") return undefined;
    recordEvent(ctx, { kind: "stale_docs.read_note" });
    return { content: appendText(event.content, STALE_DOCS_READ_NOTE), ...keepStructured(event) };
  });

  pi.on("message_end", (event) => {
    const m = event.message as { role: string; stopReason?: string; content?: unknown };
    if (m.role === "assistant" && Array.isArray(m.content))
      last = { stopReason: m.stopReason, content: m.content as Part[] };
  });

  pi.on("agent_before_settle", (event, ctx) => {
    if (mode !== "gate") return undefined;
    // Гейт или другая проверка уже вернули модель к работе — сначала пусть доделает.
    if (event.outcome !== "completed" || event.continue || !hasDocs || !edited || nudged || !last)
      return undefined;
    if (last.stopReason !== "stop" || last.content.some((p) => p.type === "toolCall"))
      return undefined;
    const text = last.content.map((p) => (p.type === "text" ? (p.text ?? "") : "")).join("\n");
    if (!text.trim() || DOCS_MENTIONED.test(text)) return undefined;
    nudged = true;
    recordEvent(ctx, { kind: "stale_docs.nudge" });
    return {
      entries: [
        ...event.entries,
        {
          type: "custom_message",
          customType: "prsloy-harness.stale-docs",
          content: STALE_DOCS_NUDGE,
          display: false,
        },
      ],
      continue: true,
    };
  });
}
