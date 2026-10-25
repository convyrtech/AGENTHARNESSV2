import { describe, expect, it } from "vite-plus/test";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { pickPythonExecutable } from "./context.ts";
import { resolveHarnessExtensions } from "./harness-paths.ts";
import { chooseGitBinary, chooseWindowsShellPath } from "./windows-shell.ts";

const BUNDLED = "C:\\Users\\u\\AppData\\Roaming\\PRSLOY\\runtimes\\git";
const env = { ProgramFiles: "C:\\Program Files", SystemRoot: "C:\\Windows" };

describe("Windows shell choice", () => {
  it("prefers the bundled Git Bash", () => {
    const exists = (p: string) => p === `${BUNDLED}\\bin\\bash.exe`;
    expect(chooseWindowsShellPath({ bundledGitRoot: BUNDLED, env, exists })).toEqual({
      shellPath: `${BUNDLED}\\bin\\bash.exe`,
      source: "bundled",
    });
  });

  it("falls back to a system Git for Windows", () => {
    const exists = (p: string) => p === "C:\\Program Files\\Git\\bin\\bash.exe";
    expect(chooseWindowsShellPath({ bundledGitRoot: BUNDLED, env, exists })).toEqual({
      shellPath: "C:\\Program Files\\Git\\bin\\bash.exe",
      source: "system",
    });
  });

  it("never returns the WSL launcher, even when it is the only bash", () => {
    const exists = (p: string) => p === "C:\\Windows\\System32\\bash.exe";
    const chosen = chooseWindowsShellPath({ bundledGitRoot: BUNDLED, env, exists });
    expect(chosen.source).toBe("missing");
    expect(chosen.shellPath).toBe(`${BUNDLED}\\bin\\bash.exe`);
    expect(chosen.shellPath.toLowerCase()).not.toContain("system32");
  });

  it("picks git for snapshots", () => {
    expect(chooseGitBinary({ platform: "linux", bundledGitRoot: BUNDLED, env })).toBe("git");
    expect(
      chooseGitBinary({
        platform: "win32",
        bundledGitRoot: BUNDLED,
        env,
        exists: (p) => p === `${BUNDLED}\\cmd\\git.exe`,
      }),
    ).toBe(`${BUNDLED}\\cmd\\git.exe`);
    expect(
      chooseGitBinary({ platform: "win32", bundledGitRoot: BUNDLED, env, exists: () => false }),
    ).toBe("git");
  });
});

describe("python shim target", () => {
  it("prefers the venv interpreter", () => {
    const exists = () => true;
    expect(
      pickPythonExecutable({
        platform: "win32",
        pythonVenv: "C:\\v",
        bundledPython: "C:\\p\\python.exe",
        exists,
      }),
    ).toBe(join("C:\\v", "Scripts", "python.exe"));
    expect(
      pickPythonExecutable({
        platform: "linux",
        pythonVenv: "/v",
        bundledPython: "/p/bin/python3",
        exists,
      }),
    ).toBe("/v/bin/python3");
    expect(
      pickPythonExecutable({
        platform: "linux",
        pythonVenv: "/v",
        bundledPython: "/p/bin/python3",
        exists: (p) => p === "/p/bin/python3",
      }),
    ).toBe("/p/bin/python3");
    expect(pickPythonExecutable({ platform: "linux", exists: () => false })).toBeUndefined();
  });
});

describe("harness extension paths", () => {
  const mainModuleUrl = pathToFileURL("/repo/app/apps/desktop/dist/main/main.mjs").href;

  it("finds the monorepo package in dev and resources/ when packaged", () => {
    const dev = resolve("/repo/app/packages/prsloy-harness");
    expect(
      resolveHarnessExtensions({
        env: {},
        mainModuleUrl,
        exists: (p) => p === join(dev, "package.json"),
      }),
    ).toEqual([dev]);
    expect(
      resolveHarnessExtensions({
        env: {},
        resourcesPath: "/opt/PRSLOY/resources",
        mainModuleUrl,
        exists: () => true,
      }),
    ).toEqual([join("/opt/PRSLOY/resources", "prsloy-harness")]);
  });

  it("honours PRSLOY_HARNESS_DIR and PRSLOY_HARNESS=0", () => {
    expect(
      resolveHarnessExtensions({ env: { PRSLOY_HARNESS_DIR: "/x/h" }, exists: () => true }),
    ).toEqual([resolve("/x/h")]);
    expect(resolveHarnessExtensions({ env: { PRSLOY_HARNESS: "0" }, exists: () => true })).toEqual(
      [],
    );
    expect(resolveHarnessExtensions({ env: {}, mainModuleUrl, exists: () => false })).toEqual([]);
  });
});
