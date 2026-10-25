/**
 * Pure parts of packaged-smoke.mjs (the smoke itself runs after `pnpm package`).
 * Run: node apps/desktop/scripts/packaged-smoke.test.mjs
 */
import { aclIsUserOnly, packagedExecutable } from "./packaged-smoke.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// icacls output after `icacls dir /inheritance:r /grant:r *SID:(OI)(CI)F`
const userOnly = `C:\\Users\\runneradmin\\AppData\\Roaming\\PRSLOY\\prsloy runneradmin-pc\\runneradmin:(OI)(CI)(F)

Successfully processed 1 files; Failed processing 0 files`;
assert(aclIsUserOnly(userOnly), "single user grant is user-only");

const inherited = `C:\\x\\prsloy NT AUTHORITY\\SYSTEM:(I)(OI)(CI)(F)
                 BUILTIN\\Administrators:(I)(OI)(CI)(F)
                 PC\\me:(I)(OI)(CI)(F)

Successfully processed 1 files; Failed processing 0 files`;
assert(!aclIsUserOnly(inherited), "inherited ACL is not user-only");

const usersRead = `C:\\x\\prsloy PC\\me:(OI)(CI)(F)
                 BUILTIN\\Users:(OI)(CI)(RX)`;
assert(!aclIsUserOnly(usersRead), "Users read access is not user-only");

assert(
  packagedExecutable("win32").endsWith("win-unpacked\\PRSLOY.exe") ||
    packagedExecutable("win32").endsWith("win-unpacked/PRSLOY.exe"),
  "win exe path",
);
assert(packagedExecutable("linux").endsWith("linux-unpacked/PRSLOY"), "linux exe path");

console.log("packaged-smoke.test.mjs: ok");
