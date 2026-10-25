/**
 * `ask_owner` — the «Дизайн» agent's only way to ask the owner (research/20 §8). run.py loads it into
 * every Pi session of a step (`pi -e ask_owner.ts`). A valid call ends the session (`terminate`): the
 * owner answers in the app, and the answer is the next owner message. run.py takes the question and
 * the buttons from this tool's result (`details`), not from the text, so a card always has its buttons.
 *
 * Shape after Open CoDesign `packages/core/src/tools/ask.ts` (MIT, Copyright (c) OpenCoworkAI): typed
 * questions, a pure validator shared by the tool and its tests. Only two types here: `text-options`
 * (2–4 answers, one of them recommended) and `freeform` (the owner types); no svg, slider or file.
 * Rules of the pipeline's owner message (flow.py `lint_message`, step 0a): at most three questions,
 * 2–4 options each, a recommendation for each. A broken call is a tool error with the reason, so the
 * model fixes it and calls again; nothing reaches the owner.
 *
 * The «Код» tab's `ask_user` (`app/packages/prsloy-harness/src/ask-user.ts`) asks inside a running
 * session through `ctx.ui`; this one ends the session, and it has to load from the design bundle with
 * no app packages around it, so it keeps its own copy of the option cleaning (same rules).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const MAX_QUESTIONS = 3;
const LETTERS = ["A", "B", "C", "D"];

export type AskOwnerQuestion = {
  type: "text-options" | "freeform";
  prompt: string;
  options?: string[];
  recommended?: string;
  placeholder?: string;
};

export type AskOwner = {
  message: string;
  questions: {
    type: "text-options" | "freeform";
    prompt: string;
    options: { key: string; label: string; recommended: boolean }[];
    placeholder?: string;
  }[];
};

/** An answer as the owner reads it: no letter in front, no «(рекомендую)», single spaces. */
function cleanOption(raw: unknown): string {
  return String(raw ?? "")
    .replace(/\s+/gu, " ")
    .replace(/^\s*[A-DА-Г][.)]\s+/u, "")
    .replace(/\s*[(—–-]?\s*рекомендую\s*\)?\s*$/iu, "")
    .trim();
}

/** The call as the owner will see it, or the reason the model must fix (Russian, one line). */
export function checkAsk(input: unknown): { ok: true; ask: AskOwner } | { ok: false; reason: string } {
  const obj = (input ?? {}) as { message?: unknown; questions?: unknown };
  const message = typeof obj.message === "string" ? obj.message.trim() : "";
  if (message.length > 1500) return { ok: false, reason: "message длиннее 1500 знаков: до 5 строк по шаблону" };
  const questions = Array.isArray(obj.questions) ? obj.questions : [];
  if (questions.length === 0) return { ok: false, reason: "нет ни одного вопроса в questions" };
  if (questions.length > MAX_QUESTIONS) {
    return {
      ok: false,
      reason: `вопросов ${questions.length}, за раз не больше ${MAX_QUESTIONS}: оставь главные, остальное реши сам`,
    };
  }
  const out: AskOwner["questions"] = [];
  for (const [i, raw] of questions.entries()) {
    const q = (raw ?? {}) as AskOwnerQuestion;
    const n = `вопрос ${i + 1}`;
    const prompt = String(q.prompt ?? "").replace(/\s+/gu, " ").trim();
    if (!prompt) return { ok: false, reason: `${n}: пустой prompt` };
    if (prompt.length > 300) return { ok: false, reason: `${n}: prompt длиннее 300 знаков` };
    if (q.type === "freeform") {
      if (questions.length > 1) {
        return { ok: false, reason: `${n}: вопрос без вариантов (freeform) задаётся один, без других вопросов` };
      }
      const placeholder = String(q.placeholder ?? "").trim().slice(0, 80);
      out.push({ type: "freeform", prompt, options: [], ...(placeholder ? { placeholder } : {}) });
      continue;
    }
    if (q.type !== "text-options") {
      return { ok: false, reason: `${n}: type только «text-options» или «freeform»` };
    }
    const options: string[] = [];
    for (const o of Array.isArray(q.options) ? q.options : []) {
      const label = cleanOption(o);
      if (label && !options.includes(label)) options.push(label);
    }
    if (options.length < 2 || options.length > 4) {
      return { ok: false, reason: `${n}: вариантов ${options.length}, нужно от 2 до 4 разных` };
    }
    const long = options.find((o) => o.length > 160);
    if (long) return { ok: false, reason: `${n}: вариант длиннее 160 знаков: «${long.slice(0, 40)}…»` };
    const recommended = cleanOption(q.recommended);
    if (!recommended || !options.includes(recommended)) {
      return {
        ok: false,
        reason: `${n}: нет рекомендации — в recommended впиши один из вариантов дословно`,
      };
    }
    out.push({
      type: "text-options",
      prompt,
      options: options.map((label, k) => ({
        key: LETTERS[k]!,
        label,
        recommended: label === recommended,
      })),
    });
  }
  return { ok: true, ask: { message, questions: out } };
}

export default function askOwner(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ask_owner",
    label: "вопрос владельцу",
    description:
      "Ask the page's owner and end this session; the answer comes as the owner's next message. The ONLY way to " +
      "ask the owner anything. In Russian, plain words, nothing technical. `message`: up to 5 short lines of what " +
      "you did, with the path of the picture or video to show on its own line. `questions`: 1–3; each " +
      "`text-options` has 2–4 short `options` and `recommended` (one of them, copied exactly); a `freeform` " +
      "question (the owner types, e.g. a name) goes alone. After this call write nothing else.",
    promptSnippet: "Ask the owner (buttons or a typed answer); ends the session",
    parameters: Type.Object({
      message: Type.String({ description: "Up to 5 lines for the owner; picture/video path on its own line" }),
      questions: Type.Array(
        Type.Object({
          type: Type.String({ description: "«text-options» or «freeform»" }),
          prompt: Type.String({ description: "The question, short" }),
          options: Type.Optional(Type.Array(Type.String(), { description: "text-options: 2–4 answers" })),
          recommended: Type.Optional(Type.String({ description: "text-options: the answer you recommend" })),
          placeholder: Type.Optional(Type.String({ description: "freeform: a hint in the input field" })),
        }),
        { description: "1–3 questions" },
      ),
    }),
    async execute(_id, params) {
      const checked = checkAsk(params);
      // a tool error: the model reads the reason and calls again; the owner sees nothing
      if (!checked.ok) throw new Error(`ask_owner не принят: ${checked.reason}`);
      return {
        content: [{ type: "text", text: "Вопрос ушёл владельцу. Сессия закончена: его ответ придёт сообщением." }],
        details: checked.ask,
        terminate: true,
      };
    },
  });
}
