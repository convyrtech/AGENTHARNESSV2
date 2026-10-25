/**
 * Side-effect module, imported first by main/index.ts: pick `<appData>/PRSLOY` as userData
 * (moving an old `@zeno/desktop` profile over once) before anything reads the path.
 */
import { app } from "electron";
import { rmSync } from "node:fs";
import { migrateLegacyUserData, prsloyUserDataDir } from "./user-data.ts";

const plan = prsloyUserDataDir({
  appData: app.getPath("appData"),
  packaged: app.isPackaged,
  explicitUserDataDir: app.commandLine.hasSwitch("user-data-dir"),
});
if (plan) {
  const migration = migrateLegacyUserData(plan);
  if (migration.status === "failed") {
    // Keep using the old profile this time rather than start from a half-copied one.
    console.warn("[prsloy] profile move failed, staying on the old one:", migration.error);
    rmSync(plan.target, { recursive: true, force: true });
    app.setPath("userData", plan.legacy);
  } else {
    if (migration.status !== "none") {
      console.log(`[prsloy] profile ${migration.status}: ${migration.from} → ${migration.to}`);
    }
    app.setPath("userData", plan.target);
  }
}
