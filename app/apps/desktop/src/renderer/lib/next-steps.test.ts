import { describe, expect, it } from "vite-plus/test";
import {
  extractNextSteps,
  fallbackNextSteps,
  selectNextSteps,
  withoutNextTag,
} from "./next-steps.ts";
import type { TimelineItem } from "./timeline.ts";

const REPLY =
  "Готово: сайт в index.html.\n\n<prsloy-next>\n- Добавь форму заявки\n2. Сделай версию для телефона\nДобавь форму заявки\n</prsloy-next>\n";

describe("the <prsloy-next> tag", () => {
  it("reads the last closed tag at the end, without list marks or repeats", () => {
    expect(extractNextSteps(REPLY)).toEqual(["Добавь форму заявки", "Сделай версию для телефона"]);
    expect(extractNextSteps(`${REPLY}\nЕщё текст после`)).toEqual([]);
    expect(
      extractNextSteps("<prsloy-next>\nа\n</prsloy-next> <prsloy-next>б\nв\nг\nд</prsloy-next>"),
    ).toEqual(["б", "в", "г"]);
    expect(extractNextSteps(`<prsloy-next>${"я".repeat(121)}\nок</prsloy-next>`)).toEqual(["ок"]);
    expect(extractNextSteps("<prsloy-next>не закрыт")).toEqual([]);
  });

  it("never shows in the reply, even while it streams", () => {
    expect(withoutNextTag(REPLY)).toBe("Готово: сайт в index.html.");
    expect(withoutNextTag("Готово.\n<prsloy-next>\nДобавь фор")).toBe("Готово.");
    expect(withoutNextTag("обычный текст")).toBe("обычный текст");
  });
});

const user = (text: string): TimelineItem => ({ id: `u${text}`, kind: "user", text });
const reply = (text: string): TimelineItem => ({ id: `a${text}`, kind: "assistant", text });
const write = (path: string, content = "", status: "completed" | "error" = "completed") =>
  ({
    id: `t${path}`,
    kind: "tool",
    toolName: "write",
    status,
    args: { path, content },
  }) as TimelineItem & {
    kind: "tool";
  };

const bash = (command: string, status: "completed" | "error", toolName = "bash") =>
  ({
    id: `b${command}${status}`,
    kind: "tool",
    toolName,
    status,
    args: { command },
  }) as TimelineItem & { kind: "tool" };

describe("fallback steps from the turn's files", () => {
  it("a failed run comes first: fix it, not «проверь, что всё работает»", () => {
    const steps = fallbackNextSteps("ru", [write("prices.py"), bash("python3 prices.py", "error")]);
    expect(steps).toEqual([
      "Почини ошибку и запусти снова",
      "Объясни простыми словами, что сломалось",
    ]);
    // npm wrote nothing, still a failed run
    expect(fallbackNextSteps("ru", [bash("npm install express", "error")])).toHaveLength(2);
    expect(
      fallbackNextSteps("ru", [bash("python3 -m http.server", "error", "bash_background")]),
    ).toHaveLength(2);
    // fixed within the turn: the last run passed
    expect(
      fallbackNextSteps("ru", [
        write("prices.py"),
        bash("python3 prices.py", "error"),
        bash("python3 prices.py", "completed"),
      ]),
    ).not.toContain("Почини ошибку и запусти снова");
  });

  it("a page, a bot, other code, nothing", () => {
    expect(fallbackNextSteps("ru", [write("site/index.html")])).toEqual([
      "Сделай, чтобы на телефоне тоже было красиво",
      "Добавь форму заявки",
      "Сделай дизайн ярче",
    ]);
    expect(fallbackNextSteps("ru", [write("bot.py", "from aiogram import Bot")])[0]).toBe(
      "Добавь боту команду /help",
    );
    expect(fallbackNextSteps("ru", [write("calc.py", "print(2+2)")])).toHaveLength(2);
    expect(fallbackNextSteps("ru", [write("index.html", "", "error")])).toEqual([]);
    expect(fallbackNextSteps("ru", [])).toEqual([]);
  });
});

describe("selectNextSteps", () => {
  it("after the last finished turn only", () => {
    const items = [user("сделай сайт"), write("index.html"), reply("Готово.")];
    expect(selectNextSteps("ru", items, false)).toHaveLength(3);
    expect(selectNextSteps("ru", items, true)).toEqual([]);
    expect(selectNextSteps("ru", [...items, user("ещё")], false)).toEqual([]);
    expect(selectNextSteps("ru", [user("привет"), reply("Привет!")], false)).toEqual([]);
  });

  it("prefers the model's own steps, hides after a failed turn", () => {
    expect(selectNextSteps("ru", [user("x"), write("a.html"), reply(REPLY)], false)).toEqual([
      "Добавь форму заявки",
      "Сделай версию для телефона",
    ]);
    const failed: TimelineItem = { id: "e", kind: "system", text: "сбой", tone: "error" };
    expect(selectNextSteps("ru", [user("x"), write("a.html"), failed, reply("…")], false)).toEqual(
      [],
    );
    expect(selectNextSteps("ru", [user("x"), write("a.html"), failed], false)).toEqual([]);
  });

  it("the turn-status card after the reply does not hide the steps", () => {
    const status: TimelineItem = {
      id: "s",
      kind: "system",
      text: "Нечем проверить",
      title: "prsloy-harness.turn-status",
      extension: true,
      details: { facts: ["no-checks"] },
    };
    expect(
      selectNextSteps(
        "ru",
        [user("сделай сайт"), write("index.html"), reply("Готово."), status],
        false,
      ),
    ).toHaveLength(3);
  });

  it("stays after «Откатить ход»: the undo note after the reply is not the turn's end", () => {
    const note: TimelineItem = {
      id: "n",
      kind: "system",
      text: "Пользователь откатил ход",
      extension: true,
      title: "prsloy-undo",
    };
    const items = [user("сделай фон тёмным"), write("index.html"), reply("Сделал."), note];
    expect(selectNextSteps("ru", items, false)).toHaveLength(3);
  });
});
