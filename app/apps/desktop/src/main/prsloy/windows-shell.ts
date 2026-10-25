/**
 * Shell + git selection for the agent on Windows.
 *
 * Pi's bash tool picks: settings `shellPath` → `%ProgramFiles%\Git\bin\bash.exe` →
 * `where bash.exe` (may be the WSL launcher, which silently runs inside Linux) → throw.
 * We always set `shellPath`, so pi never reaches the `where` fallback: the bundled
 * PortableGit bash first, a system Git for Windows second, and otherwise the bundled
 * path anyway (pi then reports "shell not found" instead of running WSL).
 */
import { existsSync } from "node:fs";
import { win32 } from "node:path";

export type BundledGitLayout = {
  root: string;
  /** `bin\bash.exe`: Git's launcher (sets MSYSTEM + PATH, then runs usr\bin\bash). */
  bash: string;
  /** `cmd\git.exe`. */
  git: string;
};

export function bundledGitLayout(root: string): BundledGitLayout {
  return {
    root,
    bash: win32.join(root, "bin", "bash.exe"),
    git: win32.join(root, "cmd", "git.exe"),
  };
}

function systemGitRoots(env: NodeJS.ProcessEnv): string[] {
  const roots: string[] = [];
  if (env.ProgramFiles) roots.push(win32.join(env.ProgramFiles, "Git"));
  if (env["ProgramFiles(x86)"]) roots.push(win32.join(env["ProgramFiles(x86)"], "Git"));
  if (env.LOCALAPPDATA) roots.push(win32.join(env.LOCALAPPDATA, "Programs", "Git"));
  return roots;
}

export function chooseWindowsShellPath(options: {
  bundledGitRoot: string;
  env: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
}): { shellPath: string; source: "bundled" | "system" | "missing" } {
  const exists = options.exists ?? existsSync;
  const bundled = bundledGitLayout(options.bundledGitRoot).bash;
  if (exists(bundled)) return { shellPath: bundled, source: "bundled" };
  for (const root of systemGitRoots(options.env)) {
    const bash = bundledGitLayout(root).bash;
    if (exists(bash)) return { shellPath: bash, source: "system" };
  }
  return { shellPath: bundled, source: "missing" };
}

/** git executable for shadow snapshots (works without a system git on Windows). */
export function chooseGitBinary(options: {
  platform: NodeJS.Platform;
  bundledGitRoot: string;
  env: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
}): string {
  if (options.platform !== "win32") return "git";
  const exists = options.exists ?? existsSync;
  const bundled = bundledGitLayout(options.bundledGitRoot).git;
  if (exists(bundled)) return bundled;
  for (const root of systemGitRoots(options.env)) {
    const git = bundledGitLayout(root).git;
    if (exists(git)) return git;
  }
  return "git";
}
