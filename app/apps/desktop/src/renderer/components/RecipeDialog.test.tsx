// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { RecipeInfo } from "@zeno/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { RecipeDialog } from "./RecipeDialog.tsx";

const recipe: RecipeInfo = {
  id: "visit-card",
  title: "Визитка",
  description: "Одна страница о вас.",
  icon: "id-card",
  params: [
    { key: "name", label: "Как вас зовут?", inputType: "string", required: true },
    {
      key: "style",
      label: "Какой стиль?",
      inputType: "select",
      required: false,
      options: ["Спокойный", "Яркий"],
      default: "Спокойный",
    },
    { key: "form", label: "Нужна форма", inputType: "boolean", required: false, default: true },
  ],
};
const createRecipe = vi.fn();
// Radix Switch measures itself; jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

beforeEach(() => {
  createRecipe.mockReset().mockResolvedValue({ ok: true, path: "/d/Визитка", prompt: "Сделай…" });
  (window as unknown as { zeno: unknown }).zeno = { features: { createRecipe } };
});
afterEach(cleanup);

describe("RecipeDialog", () => {
  it("asks the questions with labels and sends the answers", async () => {
    const onStart = vi.fn();
    render(<RecipeDialog locale="ru" recipe={recipe} onClose={() => {}} onStart={onStart} />);
    const name = screen.getByLabelText(/Как вас зовут\?/u);
    expect(screen.getByRole("radiogroup", { name: "Какой стиль?" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Нужна форма" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    // Empty required answer: said next to the field, nothing created.
    fireEvent.click(screen.getByTestId("recipe-start"));
    expect((await screen.findByRole("alert")).textContent).toBe("Заполните это поле");
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(createRecipe).not.toHaveBeenCalled();
    fireEvent.change(name, { target: { value: "Анна" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(name.getAttribute("aria-invalid")).toBe("false");
    fireEvent.click(screen.getByRole("radio", { name: "Яркий" }));
    fireEvent.click(screen.getByRole("switch", { name: "Нужна форма" }));
    fireEvent.click(screen.getByTestId("recipe-start"));
    await waitFor(() =>
      expect(createRecipe).toHaveBeenCalledWith("visit-card", {
        name: "Анна",
        style: "Яркий",
        form: false,
      }),
    );
    await waitFor(() => expect(onStart).toHaveBeenCalledWith("/d/Визитка", "Сделай…"));
  });

  it("says plainly when the project could not be made", async () => {
    createRecipe.mockRejectedValue(new Error("нет места"));
    render(<RecipeDialog locale="ru" recipe={recipe} onClose={() => {}} onStart={() => {}} />);
    fireEvent.change(screen.getByLabelText(/Как вас зовут\?/u), { target: { value: "Анна" } });
    fireEvent.click(screen.getByTestId("recipe-start"));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Не получилось создать проект: нет места",
    );
  });
});
