/**
 * Side-effect module, imported first by main/index.ts: pick `<appData>/PRSLOY` as userData
 * (moving an old `@zeno/desktop` profile over once) before anything reads the path.
 */
import { app } from "electron";
import { rmSync } from "node:fs";
import { migrateLegacyUserData, prsloyUserDataDir } from "./user-data.ts";

// Dev and explicitly isolated profiles do not use the OS appData location at all.
// Check before getPath: Electron may be unable to resolve it in an isolated environment.
const plan =
  app.isPackaged && !app.commandLine.hasSwitch("user-data-dir")
    ? prsloyUserDataDir({
        appData: app.getPath("appData"),
        packaged: true,
        explicitUserDataDir: false,
      })
    : undefined;
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
