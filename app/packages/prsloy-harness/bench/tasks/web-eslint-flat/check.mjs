// eslint ^<последний мажор>; с ESLint 9 — плоский конфиг eslint.config.*, старого .eslintrc.* нет.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { latestMajorRange, major, npmLatest } from "../../lib/live.mjs";

export default async function check({ ws }) {
  const version = await latestMajorRange(ws, "eslint");
  const flat = [
    "eslint.config.js",
    "eslint.config.mjs",
    "eslint.config.cjs",
    "eslint.config.ts",
  ].some((f) => existsSync(join(ws, f)));
  const old = [
    ".eslintrc.json",
    ".eslintrc.js",
    ".eslintrc.cjs",
    ".eslintrc",
    ".eslintrc.yml",
  ].some((f) => existsSync(join(ws, f)));
  const needFlat = major(await npmLatest("eslint")) >= 9;
  const config = needFlat ? flat && !old : true;
  return {
    ok: version.ok && config,
    note: `${version.note}; конфиг ${flat ? "eslint.config" : "нет плоского"}${old ? ", остался .eslintrc" : ""}`,
  };
}
