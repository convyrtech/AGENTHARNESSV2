// ask_user (вопрос кнопками) и request_secret (ключ формой) — research/19 §1.1, §1.3.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { ASK_MAX_PER_MESSAGE, ASK_TEXT, installAskUser } from "../src/ask-user.ts";
import { configureLearning, onLearningEvent, type LearningEvent } from "../src/learning-log.ts";
import { resolveOptions } from "../src/options.ts";
import {
  installRequestSecret,
  saveToEnv,
  SECRET_PLACEHOLDER_PREFIX,
  SECRET_TEXT,
} from "../src/request-secret.ts";
import { scrubSecrets } from "../src/secret-scrub.ts";
import { MockPi } from "./mock-pi.ts";

const root = mkdtempSync(join(tmpdir(), "prsloy-ask-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
configureLearning({ enabled: true, dir: join(root, "learning") });

interface Dialogs {
  select?: (title: string, options: string[]) => string | undefined;
  input?: (title: string, placeholder?: string) => string | undefined;
}

let n = 0;
function setup(dialogs: Dialogs | null, profile: "code" | "design" = "code") {
  const cwd = join(root, `p${n++}`);
  mkdirSync(cwd, { recursive: true });
  const pi = new MockPi(cwd);
  const seen = { select: [] as [string, string[]][], input: [] as [string, string | undefined][] };
  const ctx = pi.ctx as unknown as Record<string, unknown>;
  ctx.hasUI = dialogs !== null;
  ctx.sessionManager = { getSessionId: () => `s${n}` };
  ctx.ui = {
    notify() {},
    setStatus() {},
    select: async (title: string, options: string[]) => {
      seen.select.push([title, options]);
      return dialogs?.select?.(title, options);
    },
    input: async (title: string, placeholder?: string) => {
      seen.input.push([title, placeholder]);
      return dialogs?.input?.(title, placeholder);
    },
  };
  const opts = resolveOptions({ profile });
  installAskUser(pi.api, opts);
  installRequestSecret(pi.api, opts);
  const events: LearningEvent[] = [];
  const off = onLearningEvent((_s, e) => events.push(e));
  const call = async (tool: string, params: Record<string, unknown>) => {
    const r = (await pi.tool(tool).execute("t", params, undefined, undefined, pi.ctx as never)) as {
      content: { text: string }[];
      details: Record<string, unknown>;
      isError?: boolean;
    };
    return { text: r.content[0]!.text, details: r.details, isError: r.isError === true };
  };
  const userMessage = async () => {
    for (const h of pi.handlers.get("before_agent_start") ?? [])
      await h(
        {
          type: "before_agent_start",
          messageType: "user",
          prompt: "…",
          systemPrompt: "",
          systemPromptOptions: { sections: {} },
        },
        pi.ctx,
      );
  };
  return { pi, cwd, seen, events, off, call, userMessage };
}

const site = {
  question: "Какой сайт сделать для кофейни?",
  options: ["Меню с ценами", "Страница с адресом и часами", "Заказ кофе онлайн"],
  recommended: "Страница с адресом и часами",
};

describe("ask_user", () => {
  it("recommended first with a mark, then the rest, then «Как рекомендуешь» and «Свой ответ»", async () => {
    const t = setup({ select: (_t, o) => o[2] });
    await t.userMessage();
    const r = await t.call("ask_user", site);
    expect(t.seen.select[0]).toEqual([
      site.question,
      [
        `Страница с адресом и часами${ASK_TEXT.mark}`,
        "Меню с ценами",
        "Заказ кофе онлайн",
        ASK_TEXT.recommend,
        ASK_TEXT.own,
      ],
    ]);
    expect(r.text).toBe("Пользователь выбрал: «Заказ кофе онлайн».");
    expect(t.events.at(-1)).toMatchObject({ kind: "ask", sig: "ask:option", n: 1 });
    t.off();
  });

  it("the recommended button, «Как рекомендуешь» and closing all give the recommendation", async () => {
    for (const [pick, how] of [
      [(o: string[]) => o[0], "option"],
      [() => ASK_TEXT.recommend, "recommended"],
      [() => undefined, "dismissed"],
    ] as const) {
      const t = setup({ select: (_t, o) => pick(o) });
      await t.userMessage();
      const r = await t.call("ask_user", site);
      expect(r.details).toMatchObject({ how, answer: site.recommended });
      expect(r.text).toContain("«Страница с адресом и часами»");
      t.off();
    }
  });

  it("«Свой ответ» opens an input; an empty answer falls back to the recommendation", async () => {
    const own = setup({ select: () => ASK_TEXT.own, input: () => "  Сайт с акциями  " });
    await own.userMessage();
    expect((await own.call("ask_user", site)).text).toBe(
      "Пользователь ответил своими словами: «Сайт с акциями».",
    );
    expect(own.seen.input[0]).toEqual([site.question, ASK_TEXT.ownPlaceholder]);
    own.off();
    const empty = setup({ select: () => ASK_TEXT.own, input: () => " " });
    expect((await empty.call("ask_user", site)).details).toMatchObject({
      how: "dismissed",
      answer: site.recommended,
    });
    empty.off();
  });

  it(`at most ${ASK_MAX_PER_MESSAGE} questions per user message; a new message resets the cap`, async () => {
    const t = setup({ select: (_t, o) => o[1] });
    await t.userMessage();
    await t.call("ask_user", site);
    await t.call("ask_user", site);
    const third = await t.call("ask_user", site);
    expect(third.details).toMatchObject({ how: "cap" });
    expect(third.text).toContain("Не спрашивай снова");
    expect(t.seen.select).toHaveLength(2);
    await t.userMessage();
    expect((await t.call("ask_user", site)).details).toMatchObject({ how: "option" });
    t.off();
  });

  it("no window (print mode) — take the recommendation and name it", async () => {
    const t = setup(null);
    const r = await t.call("ask_user", site);
    expect(r.details).toMatchObject({ how: "no-ui", answer: site.recommended });
    expect(r.text).toContain("скажи, что исходил из него");
    t.off();
  });

  it("an unknown `recommended` falls back to the first option; our button labels are dropped", async () => {
    const t = setup({ select: (_t, o) => o[0] });
    const r = await t.call("ask_user", {
      question: "Цвет?",
      options: ["Синий", ASK_TEXT.own, "Синий", "Зелёный"],
      recommended: "Красный",
    });
    expect(t.seen.select[0]![1]).toEqual([
      `Синий${ASK_TEXT.mark}`,
      "Зелёный",
      ASK_TEXT.recommend,
      ASK_TEXT.own,
    ]);
    expect(r.details).toMatchObject({ answer: "Синий" });
    t.off();
  });

  it("only in the Code profile", () => {
    const t = setup(null, "design");
    expect(t.pi.tools.has("ask_user")).toBe(false);
    expect(t.pi.tools.has("request_secret")).toBe(false);
    t.off();
  });
});

describe("request_secret", () => {
  const token = `7123456789:AAH${"x9Y_z-".repeat(5)}Qw`;
  const ask = {
    name: "TELEGRAM_BOT_TOKEN",
    reason: "Токен бота — его выдаёт @BotFather в Telegram",
  };

  it("form → .env and .gitignore; the model gets only the name; the value is scrubbed everywhere", async () => {
    const t = setup({ input: () => `  ${token}  ` });
    const r = await t.call("request_secret", ask);
    expect(t.seen.input[0]).toEqual([
      `Нужен ключ: ${ask.reason}`,
      `${SECRET_PLACEHOLDER_PREFIX}TELEGRAM_BOT_TOKEN`,
    ]);
    expect(r.text).toBe(SECRET_TEXT.saved("TELEGRAM_BOT_TOKEN"));
    expect(JSON.stringify(r)).not.toContain(token);
    expect(readFileSync(join(t.cwd, ".env"), "utf8")).toBe(`TELEGRAM_BOT_TOKEN=${token}\n`);
    expect(readFileSync(join(t.cwd, ".gitignore"), "utf8")).toBe(".env\n");
    // `cat .env` в bash: значение прячется дословно (и шаблоном Telegram, и как введённый ключ).
    expect(scrubSecrets(`TELEGRAM_BOT_TOKEN=${token}`).text).toBe(
      "TELEGRAM_BOT_TOKEN=[СКРЫТО: ключ TELEGRAM_BOT_TOKEN]",
    );
    expect(t.events.at(-1)).toMatchObject({ kind: "secret.saved", sig: "secret" });
    expect(JSON.stringify(t.events)).not.toContain(token);
    t.off();
  });

  it("a key without a known pattern is scrubbed too, once the user typed it", async () => {
    const value = "my-very-own-api-key-42";
    expect(scrubSecrets(`KEY=${value}`).count).toBe(0);
    const t = setup({ input: () => value });
    await t.call("request_secret", { name: "WEATHER_KEY", reason: "Ключ погоды" });
    expect(scrubSecrets(`console.log("${value}")`).text).toBe(
      'console.log("[СКРЫТО: ключ WEATHER_KEY]")',
    );
    t.off();
  });

  it("existing .env line is replaced, other lines kept; .gitignore with .env is left alone", () => {
    const cwd = mkdtempSync(join(root, "env-"));
    writeFileSync(join(cwd, ".env"), "PORT=3000\nexport TOKEN=old\n");
    writeFileSync(join(cwd, ".gitignore"), "node_modules\n.env\n");
    saveToEnv(cwd, "TOKEN", "new value #1");
    expect(readFileSync(join(cwd, ".env"), "utf8")).toBe('PORT=3000\nTOKEN="new value #1"\n');
    expect(readFileSync(join(cwd, ".gitignore"), "utf8")).toBe("node_modules\n.env\n");
    writeFileSync(join(cwd, ".gitignore"), "dist");
    saveToEnv(cwd, "OTHER", "x");
    expect(readFileSync(join(cwd, ".gitignore"), "utf8")).toBe("dist\n.env\n");
  });

  it("declined or closed — nothing written, «do not ask in the chat»", async () => {
    for (const answer of [undefined, "", "two\nlines"]) {
      const t = setup({ input: () => answer });
      const r = await t.call("request_secret", ask);
      expect(r.details).toEqual({ name: "TELEGRAM_BOT_TOKEN", saved: false });
      expect(r.text).toContain("Не проси его в чате");
      expect(existsSync(join(t.cwd, ".env"))).toBe(false);
      t.off();
    }
  });

  it("bad name — error, no dialog; no window — tell the user, do not ask in the chat", async () => {
    const t = setup({ input: () => token });
    const bad = await t.call("request_secret", { name: "1 bad name", reason: "?" });
    expect(bad.isError).toBe(true);
    expect(t.seen.input).toHaveLength(0);
    t.off();
    const noUi = setup(null);
    expect((await noUi.call("request_secret", ask)).text).toBe(
      SECRET_TEXT.noUi("TELEGRAM_BOT_TOKEN"),
    );
    noUi.off();
  });
});
