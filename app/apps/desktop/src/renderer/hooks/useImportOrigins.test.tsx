// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  importOriginOf,
  refreshImportOrigins,
  resetImportOriginsForTest,
  useImportOrigins,
} from "./useImportOrigins.ts";
import { ImportedBadge, ImportedChatNotice } from "../components/prsloy/ImportedChatMarks.tsx";

afterEach(() => {
  cleanup();
  resetImportOriginsForTest();
});

function Probe({ path }: { path: string }) {
  const importedFrom = useImportOrigins();
  const tool = importedFrom(path);
  return tool ? <ImportedBadge tool={tool} locale="ru" /> : <span>обычный</span>;
}

describe("useImportOrigins", () => {
  it("matches Windows paths case- and slash-insensitively, as main normalized them", () => {
    const origins = {
      origins: { "c:/users/пётр/sessions/a.jsonl": "codex" as const },
      foldCase: true,
    };
    expect(importOriginOf(origins, "C:\\Users\\Пётр\\sessions\\A.jsonl")).toBe("codex");
    expect(importOriginOf(origins, "C:\\Users\\Пётр\\sessions\\b.jsonl")).toBeUndefined();
    expect(importOriginOf(origins, undefined)).toBeUndefined();
  });

  it("asks main once, shares the answer and refreshes after an import", async () => {
    const originsApi = vi
      .fn()
      .mockResolvedValueOnce({ origins: {}, foldCase: false })
      .mockResolvedValueOnce({ origins: { "/s/a.jsonl": "claude-code" }, foldCase: false });
    (window as unknown as { zeno: unknown }).zeno = { sessionImport: { origins: originsApi } };
    render(
      <>
        <Probe path="/s/a.jsonl" />
        <Probe path="/s/b.jsonl" />
      </>,
    );
    await waitFor(() => expect(originsApi).toHaveBeenCalledTimes(1));
    expect(screen.getAllByText("обычный")).toHaveLength(2);
    await refreshImportOrigins();
    expect(await screen.findByTestId("imported-badge")).toHaveProperty(
      "textContent",
      "Claude Code",
    );
    expect(screen.getByTestId("imported-badge").getAttribute("title")).toBe(
      "Перенесён из Claude Code",
    );
    expect(screen.getAllByText("обычный")).toHaveLength(1);
  });

  it("marks nothing when main has no import", async () => {
    (window as unknown as { zeno: unknown }).zeno = {};
    render(<Probe path="/s/a.jsonl" />);
    expect(await screen.findByText("обычный")).toBeTruthy();
  });

  it("says in the chat what the model works from", () => {
    render(<ImportedChatNotice tool="gemini" locale="ru" />);
    expect(screen.getByRole("note").textContent).toBe(
      "Перенесено из Gemini CLI. Модель видит сводку разговора и последние ходы, а не всю переписку.",
    );
  });
});
