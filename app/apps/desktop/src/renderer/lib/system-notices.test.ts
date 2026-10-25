import { describe, expect, it } from "vite-plus/test";
import { isModelFailure, localizedSystemTitle } from "./system-notices.ts";

describe("system notices", () => {
  it("says a failed response in plain Russian", () => {
    expect(localizedSystemTitle("ru", "Response failed")).toBe("Связь с моделью оборвалась");
    expect(localizedSystemTitle("ru", "Response stopped")).toBe("Ответ остановлен");
    expect(localizedSystemTitle("ru", "Retry")).toBe("Повтор");
  });

  it("passes unknown titles through", () => {
    expect(localizedSystemTitle("ru", "my-extension")).toBe("my-extension");
  });

  it("recognises a model failure only as an error-toned failed response", () => {
    expect(isModelFailure({ title: "Response failed", tone: "error" })).toBe(true);
    expect(isModelFailure({ title: "Response failed", tone: "info" })).toBe(false);
    expect(isModelFailure({ title: "Response stopped", tone: "error" })).toBe(false);
  });
});
