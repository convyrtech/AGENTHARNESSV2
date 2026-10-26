// Статус хода по фактам (H9, research/24 §4.4–4.5): одна карточка в конце хода по контракту ui.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { resolveOptions } from "../src/options.ts";
import {
  createTurnStatus,
  installTurnStatus,
  TURN_STATUS_TYPE,
  stubFiles,
  TURN_FACT_TEXT,
  turnFacts,
  turnStatusLine,
  type TurnStatusState,
} from "../src/turn-status.ts";
import { MockPi } from "./mock-pi.ts";

const state = (over: Partial<TurnStatusState>): TurnStatusState => ({
  ...createTurnStatus(),
  ...over,
});

function patchOf(file: string, removed: string[], added: string[], mode = ""): string {
  return [
    `diff --git a/${file} b/${file}`,
    ...(mode ? [mode] : []),
    `--- a/${file}`,
    `+++ b/${file}`,
    "@@ -1 +1 @@",
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
  ].join("\n");
}

describe("turn status facts", () => {
  it("nothing done (a question) → no card", () => {
    expect(turnFacts(state({}), undefined, 0)).toBeUndefined();
  });

  it("green check, page, program run; red overrides green", () => {
    expect(turnFacts(state({ edited: true, gate: "green", hasCheck: true }), "", 1)?.facts).toEqual(
      ["checks-pass"],
    );
    expect(
      turnFacts(state({ edited: true, gate: "red", hasCheck: true, page: true }), "", 1)?.facts,
    ).toEqual(["checks-fail", "page-ok"]);
    // Программа отработала или страница открылась — «нечем проверить» не добавляется.
    expect(turnFacts(state({ edited: true, ranOk: true }), "", 1)?.facts).toEqual(["ran-ok"]);
    expect(turnFacts(state({ edited: true, page: true }), "", 1)?.facts).toEqual(["page-ok"]);
    expect(turnFacts(state({ edited: true }), "", 1)?.facts).toEqual(["no-checks"]);
  });

  it("page check: errors left → page-fail; clean with hints → page-ok + page-hints; findings in details", () => {
    const found = [
      "(через сервер, 1440 px) после нажатия «Показать цены»: showPrices is not defined — #show",
    ];
    expect(
      turnFacts(state({ edited: true, hasCheck: true, page: false, pageIssues: found }), "", 1),
    ).toEqual({ facts: ["page-fail"], files: [], page: found });
    const hint = [
      "(через сервер, 1440 px) клавиатура: до «Поиск» не дойти клавишей Tab — #q (подсказка)",
    ];
    expect(
      turnFacts(state({ edited: true, hasCheck: true, page: true, pageIssues: hint }), "", 1),
    ).toEqual({ facts: ["page-hints", "page-ok"], files: [], page: hint });
    expect(turnFacts(state({ edited: true, hasCheck: true, page: true }), "", 1)).toEqual({
      facts: ["page-ok"],
      files: [],
    });
  });

  it("old tests changed: by request → tests-updated, without → tests-changed; files listed", () => {
    const patch = patchOf("test.js", ["assert.equal(f(1), 2);"], ["assert.equal(f(1), 3);"]);
    expect(
      turnFacts(state({ edited: true, gate: "green", hasCheck: true, task: "Почини" }), patch, 1),
    ).toEqual({
      facts: ["tests-changed", "checks-pass"],
      files: ["test.js"],
    });
    expect(
      turnFacts(
        state({
          edited: true,
          gate: "green",
          hasCheck: true,
          task: "Скидку теперь 15%, поправь и проверки",
        }),
        patch,
        1,
      ),
    ).toEqual({ facts: ["checks-pass", "tests-updated"], files: ["test.js"] });
  });

  it("stubs left in code (not in tests, not @abstractmethod)", () => {
    expect(stubFiles(patchOf("report.js", [], ["  // ... остальные отчёты аналогично"]))).toEqual([
      "report.js",
    ]);
    expect(stubFiles(patchOf("app.py", [], ["    raise NotImplementedError"]))).toEqual(["app.py"]);
    expect(stubFiles(patchOf("a.js", [], ['  throw new Error("Not implemented");']))).toEqual([
      "a.js",
    ]);
    expect(
      stubFiles(
        patchOf(
          "base.py",
          [],
          ["    @abstractmethod", "    def run(self):", "        raise NotImplementedError"],
        ),
      ),
    ).toEqual([]);
    expect(
      stubFiles(
        patchOf(
          "app.py",
          [],
          ["    @abstractmethod", "    def run(self): raise NotImplementedError"],
        ),
      ),
    ).toEqual([]);
    expect(stubFiles(patchOf("test_app.py", [], ["    raise NotImplementedError"]))).toEqual([]);
    expect(stubFiles(patchOf("app.js", [], ["  return total; // итог"]))).toEqual([]);
    const facts = turnFacts(
      state({ edited: true }),
      patchOf("report.js", [], ["// TODO: implement totals"]),
      1,
    );
    expect(facts).toEqual({ facts: ["stubs-left", "no-checks"], files: ["report.js"] });
  });

  it("one line in Russian, the ui's words and order", () => {
    expect(turnStatusLine(["checks-fail", "page-ok"])).toBe(
      "Проверки не прошли · Страница открылась без ошибок",
    );
    expect(Object.keys(TURN_FACT_TEXT)).toEqual([
      "checks-fail",
      "ran-fail",
      "page-fail",
      "stubs-left",
      "claim-unbacked",
      "tests-changed",
      "tests-weak",
      "page-hints",
      "checks-pass",
      "page-ok",
      "ran-ok",
      "tests-updated",
      "no-checks",
    ]);
  });
});

describe("turn status after a model failure", () => {
  it("the key is revoked mid-turn (401): no status card under the failure card; the next good turn has one", async () => {
    const pi = new MockPi(mkdtempSync(join(tmpdir(), "prsloy-ts-fail-")));
    installTurnStatus(pi.api, resolveOptions({ profile: "code" }), { state: createTurnStatus() });
    await pi.userPrompt("сделай визитку");
    await pi.call("write", { path: "index.html", content: "<h1>Hi</h1>" }, "ok");
    await pi.assistantMessage({ stopReason: "error", errorMessage: "401: Invalid API key" });
    await pi.emit("agent_settled", { aborted: false });
    expect(pi.sent.filter((m) => m.customType === TURN_STATUS_TYPE)).toEqual([]);

    await pi.userPrompt("сделай визитку");
    await pi.call("write", { path: "index.html", content: "<h1>Hi</h1>" }, "ok");
    await pi.assistantMessage({ content: [{ type: "text", text: "Готово." }] });
    await pi.emit("agent_settled", { aborted: false });
    expect(pi.sent.filter((m) => m.customType === TURN_STATUS_TYPE)).toHaveLength(1);
  });
});
