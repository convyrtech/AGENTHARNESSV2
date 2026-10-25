import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { icaclsUserOnlyArgs, parseWhoamiSid, restrictToCurrentUser } from "./file-acl.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("user-only ACL", () => {
  it("parses whoami /user csv and builds an inheritance-stripping icacls grant", () => {
    expect(parseWhoamiSid('"desktop-1\\\\runneradmin","S-1-5-21-111-222-333-500"\r\n')).toBe(
      "S-1-5-21-111-222-333-500",
    );
    expect(parseWhoamiSid("garbage")).toBeUndefined();
    expect(icaclsUserOnlyArgs("C:\\d", "S-1-5-21-1", true)).toEqual([
      "C:\\d",
      "/inheritance:r",
      "/grant:r",
      "*S-1-5-21-1:(OI)(CI)F",
    ]);
    expect(icaclsUserOnlyArgs("C:\\f", "S-1-5-21-1", false).at(-1)).toBe("*S-1-5-21-1:F");
  });

  it.skipIf(process.platform === "win32")("chmods 700/600 on POSIX", () => {
    const dir = mkdtempSync(join(tmpdir(), "prsloy-acl-"));
    dirs.push(dir);
    const file = join(dir, "key");
    writeFileSync(file, "x", { mode: 0o644 });
    expect(restrictToCurrentUser(dir, { isDir: true }).ok).toBe(true);
    expect(restrictToCurrentUser(file, { isDir: false }).ok).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
