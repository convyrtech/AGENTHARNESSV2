import { describe, expect, it } from "vite-plus/test";
import { join } from "node:path";
import { pickPythonExecutable } from "./context.ts";
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
