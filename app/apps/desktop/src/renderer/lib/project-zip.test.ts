import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { exportProjectZip, projectZipNote } from "./project-zip.ts";

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("projectZipNote", () => {
  it("names the saved file, stays quiet on cancel, explains refusals", () => {
    expect(
      projectZipNote("ru", { ok: true, path: "C:\\Users\\a\\Downloads\\Визитка.zip", files: 3 }),
    ).toEqual({
      kind: "ok",
      text: "Архив сохранён: Визитка.zip",
    });
    expect(projectZipNote("ru", { ok: false, reason: "canceled" })).toBeUndefined();
    expect(projectZipNote("ru", { ok: false, reason: "too_big" })?.text).toBe(
      "Проект больше 200 МБ — архив не собрать.",
    );
    expect(projectZipNote("ru", { ok: false, reason: "empty" })?.kind).toBe("error");
    expect(projectZipNote("ru", undefined)?.text).toBe("Не получилось сохранить архив.");
  });

  it("turns a failed call into a plain error", async () => {
    (globalThis as { window?: unknown }).window = {
      zeno: { features: { exportProjectZip: vi.fn().mockRejectedValue(new Error("ipc")) } },
    };
    expect(await exportProjectZip("ru", "/p")).toEqual({
      kind: "error",
      text: "Не получилось сохранить архив.",
    });
  });
});
