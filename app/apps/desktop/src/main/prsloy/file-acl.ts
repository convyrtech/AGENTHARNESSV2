/**
 * User-only access for directories that hold keys (PRSLOY state dir, the design proxy's
 * key dir). Applied to the *directory* before any key file is written, so files inherit
 * the restricted ACL from creation (no window where a fresh file is readable by others).
 *
 * Windows: `icacls <dir> /inheritance:r /grant:r *<SID>:(OI)(CI)F` with the current
 * user's SID from `whoami /user` (unambiguous, unlike a bare %USERNAME% on domain
 * machines). POSIX: chmod 700 / 600.
 */
import { execFileSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { join } from "node:path";

export type AclResult = { ok: boolean; detail?: string };

let cachedSid: string | undefined;

/** Parse `whoami /user /fo csv /nh` → `"DOMAIN\user","S-1-5-21-…"`. */
export function parseWhoamiSid(output: string): string | undefined {
  const match = /"(S-1-[0-9-]+)"/u.exec(output);
  return match?.[1];
}

/** icacls argv that leaves only the given SID with full control. */
export function icaclsUserOnlyArgs(path: string, sid: string, isDir: boolean): string[] {
  return [path, "/inheritance:r", "/grant:r", `*${sid}:${isDir ? "(OI)(CI)F" : "F"}`];
}

function systemTool(name: string, env: NodeJS.ProcessEnv): string {
  const root = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
  return join(root, "System32", name);
}

export function currentUserSid(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (cachedSid) return cachedSid;
  try {
    const out = execFileSync(systemTool("whoami.exe", env), ["/user", "/fo", "csv", "/nh"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
    cachedSid = parseWhoamiSid(out);
  } catch {
    cachedSid = undefined;
  }
  return cachedSid;
}

export function restrictToCurrentUser(
  path: string,
  options: { isDir: boolean; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv },
): AclResult {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (platform !== "win32") {
    try {
      chmodSync(path, options.isDir ? 0o700 : 0o600);
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }
  const sid = currentUserSid(env);
  if (!sid) return { ok: false, detail: "whoami /user returned no SID" };
  try {
    execFileSync(systemTool("icacls.exe", env), icaclsUserOnlyArgs(path, sid, options.isDir), {
      windowsHide: true,
      timeout: 15_000,
      stdio: "ignore",
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}
