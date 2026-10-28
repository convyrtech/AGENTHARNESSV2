import { describe, expect, it } from "vite-plus/test";
import { harnessToolVerb } from "./harness-tools.ts";

describe("harness tools in the feed", () => {
  it("says what the harness's own tools do, running, done and failed", () => {
    expect(harnessToolVerb("ru", "request_secret", "running")).toBe("Просит ключ");
    expect(harnessToolVerb("ru", "request_secret", "done")).toBe("Попросил ключ");
    expect(harnessToolVerb("ru", "web_search", "failed")).toBe("Ищет в интернете — не получилось");
    expect(harnessToolVerb("en", "ask_user", "running")).toBe("Asking a question");
    expect(harnessToolVerb("zh", "web_fetch", "done")).toBe("已阅读网页");
    // Разведчик (#47): в ленте одна понятная строка, без слова «explore».
    expect(harnessToolVerb("ru", "explore", "running")).toBe("Смотрит по файлам проекта");
    expect(harnessToolVerb("ru", "explore", "done")).toBe("Посмотрел по файлам проекта");
  });

  it("leaves any other tool to the generic «Вызывает {tool}»", () => {
    expect(harnessToolVerb("ru", "bash", "running")).toBeUndefined();
    expect(harnessToolVerb("ru", "some_mcp_tool", "done")).toBeUndefined();
  });
});
