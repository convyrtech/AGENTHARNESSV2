import { describe, expect, it } from "vite-plus/test";
import { combineSetupProgress } from "./context.ts";

describe("combineSetupProgress («Готовлю приложение… N%»)", () => {
  it("nothing to unpack → ready / absent, no percent", () => {
    expect(combineSetupProgress({ status: "ready" }, { status: "absent" }, undefined)).toEqual({
      status: "ready",
    });
    expect(combineSetupProgress({ status: "absent" }, { status: "absent" }, undefined)).toEqual({
      status: "absent",
    });
  });

  it("weights Node/Python files and Git files into one number below 100", () => {
    const both = combineSetupProgress(
      { status: "installing", done: 500, total: 1000 },
      { status: "installing", percent: 50 },
      1000,
    );
    expect(both).toEqual({ status: "installing", percent: 50 });
    const gitDone = combineSetupProgress(
      { status: "installing", done: 0, total: 1000 },
      { status: "ready" },
      3000,
    );
    expect(gitDone).toEqual({ status: "installing", percent: 75 });
    const almost = combineSetupProgress(
      { status: "installing", done: 1000, total: 1000 },
      { status: "ready" },
      1000,
    );
    expect(almost.percent).toBe(99);
  });

  it("a failure in either part is reported", () => {
    expect(
      combineSetupProgress({ status: "failed" }, { status: "installing", percent: 3 }, 10).status,
    ).toBe("failed");
  });
});
