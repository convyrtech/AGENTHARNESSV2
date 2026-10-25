import { describe, expect, it } from "vite-plus/test";
import { hostStatusLabel } from "./host-status.ts";

describe("hostStatusLabel", () => {
  it("says the fixed service strings in the owner's language", () => {
    expect(hostStatusLabel("Agent settled", "ru")).toBe("Готово");
    expect(hostStatusLabel("Agent running...", "ru")).toBe("Работаю…");
    expect(hostStatusLabel("Agent Host ready", "en")).toBe("Agent ready");
    expect(hostStatusLabel("正在启动 Agent Host…", "ru")).toBe("Запускаю агента…");
  });

  it("reads the numbers out of a retry and drops the path from opening a project", () => {
    expect(hostStatusLabel("Retrying 2/3…", "ru")).toBe("Пробую ещё раз: 2 из 3…");
    expect(hostStatusLabel("Opening workspace /home/anna/сайт…", "ru")).toBe("Открываю проект…");
  });

  it("passes through what is already translated", () => {
    expect(hostStatusLabel("Чат переименован", "ru")).toBe("Чат переименован");
  });
});
