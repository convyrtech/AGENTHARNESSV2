// Вопрос с вариантами кнопками в «Коде» (research/19 §1.1). Схема по мотивам Roo Code
// `ask_followup_question` (Apache-2.0) и правил research/11 (P2): один вопрос, 2–4 варианта, рекомендуемый
// первым, «Как рекомендуешь» и «Свой ответ». Код свой. Окно — ctx.ui.select / ctx.ui.input.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { recordEvent } from "./learning-log.ts";
import type { ResolvedOptions } from "./options.ts";

/** Не больше двух вопросов на одно сообщение пользователя: дешёвые модели переспрашивают. */
export const ASK_MAX_PER_MESSAGE = 2;

export const ASK_TEXT = {
  recommend: "Как рекомендуешь",
  own: "Свой ответ",
  ownPlaceholder: "Ваш ответ",
  mark: " — рекомендую",
} as const;

type How = "option" | "recommended" | "own" | "dismissed" | "cap" | "no-ui";

function sessionOf(ctx: ExtensionContext): string {
  try {
    return ctx.sessionManager.getSessionId() ?? "";
  } catch {
    return "";
  }
}

function clean(options: string[]): string[] {
  const special = new Set<string>([ASK_TEXT.recommend, ASK_TEXT.own]);
  const out: string[] = [];
  for (const raw of options) {
    const o = raw.replace(/\s+/g, " ").trim().slice(0, 120);
    if (o && !special.has(o) && !out.includes(o)) out.push(o);
  }
  return out.slice(0, 4);
}

export function installAskUser(pi: ExtensionAPI, opts: ResolvedOptions): void {
  if (opts.profile !== "code") return;
  const asked = new Map<string, number>();

  pi.on("before_agent_start", (event, ctx) => {
    if (event.messageType === "user") asked.set(sessionOf(ctx), 0);
  });

  pi.registerTool({
    name: "ask_user",
    label: "вопрос",
    description:
      "Ask the user one question with 2–4 short answer buttons, in Russian. Ask only when you cannot go on without the answer and a wrong guess would waste the work; otherwise pick the sensible default yourself and name it. Put your recommendation in `recommended` (one of the options). The user may also pick «Как рекомендуешь» or type their own answer. At most 2 questions per user message.",
    promptSnippet:
      "Ask the user one question with answer buttons (only when you cannot go on without it)",
    parameters: Type.Object({
      question: Type.String({ description: "One short question in Russian, plain words" }),
      options: Type.Array(Type.String(), {
        minItems: 2,
        maxItems: 4,
        description: "2–4 short answers in Russian",
      }),
      recommended: Type.String({ description: "The option you recommend (copied from options)" }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const options = clean(params.options);
      const recommended = options.includes(params.recommended.trim())
        ? params.recommended.trim()
        : (options[0] ?? params.recommended.trim());
      const session = sessionOf(ctx);
      const n = (asked.get(session) ?? 0) + 1;
      asked.set(session, n);

      const reply = (how: How, text: string, answer?: string) => {
        recordEvent(ctx, { kind: "ask", tool: "ask_user", sig: `ask:${how}`, n });
        return { content: [{ type: "text" as const, text }], details: { how, answer } };
      };
      const assume = `Не спрашивай снова: делай с вариантом «${recommended}» и в ответе коротко скажи, что исходил из него.`;

      if (n > ASK_MAX_PER_MESSAGE)
        return reply("cap", `На это сообщение уже было ${ASK_MAX_PER_MESSAGE} вопроса. ${assume}`);
      if (!ctx.hasUI || options.length < 2)
        return reply("no-ui", `Спросить не получилось. ${assume}`, recommended);

      const ordered = [recommended, ...options.filter((o) => o !== recommended)];
      const labels = ordered.map((o, i) => (i === 0 ? `${o}${ASK_TEXT.mark}` : o));
      const picked = await ctx.ui.select(
        params.question.trim(),
        [...labels, ASK_TEXT.recommend, ASK_TEXT.own],
        signal ? { signal } : {},
      );
      if (picked === undefined)
        return reply("dismissed", `Пользователь закрыл вопрос. ${assume}`, recommended);
      if (picked === ASK_TEXT.recommend)
        return reply(
          "recommended",
          `Пользователь доверил выбор тебе: бери «${recommended}».`,
          recommended,
        );
      if (picked === ASK_TEXT.own) {
        const own = (
          await ctx.ui.input(
            params.question.trim(),
            ASK_TEXT.ownPlaceholder,
            signal ? { signal } : {},
          )
        )?.trim();
        if (!own)
          return reply("dismissed", `Пользователь не написал ответ. ${assume}`, recommended);
        return reply("own", `Пользователь ответил своими словами: «${own}».`, own);
      }
      const answer = ordered[labels.indexOf(picked)] ?? picked;
      return reply("option", `Пользователь выбрал: «${answer}».`, answer);
    },
  });
}
