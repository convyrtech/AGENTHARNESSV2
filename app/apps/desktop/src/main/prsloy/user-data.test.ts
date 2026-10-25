import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { MIGRATED_MARKER, migrateLegacyUserData, prsloyUserDataDir } from "./user-data.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function legacyProfile() {
  const appData = mkdtempSync(join(tmpdir(), "appdata-"));
  roots.push(appData);
  const plan = prsloyUserDataDir({ appData, packaged: true, explicitUserDataDir: false })!;
  mkdirSync(join(plan.legacy, "prsloy"), { recursive: true });
  mkdirSync(join(plan.legacy, "runtimes", "python-venv"), { recursive: true });
  mkdirSync(join(plan.legacy, "agent", "sessions"), { recursive: true });
  writeFileSync(join(plan.legacy, "prsloy", "gateway-key.bin"), "encrypted");
  writeFileSync(join(plan.legacy, "runtimes", ".provisioned.json"), "{}");
  const session = join(plan.legacy, "agent", "sessions", "s1.jsonl");
  writeFileSync(session, "{}\n");
  writeFileSync(
    join(plan.legacy, "zeno-desktop.json"),
    JSON.stringify({ recentSessions: [{ sessionFile: session }] }),
  );
  return { appData, plan, session };
}

describe("prsloyUserDataDir", () => {
  it("packaged → <appData>/PRSLOY, legacy <appData>/@zeno/desktop", () => {
    expect(
      prsloyUserDataDir({ appData: "/a", packaged: true, explicitUserDataDir: false }),
    ).toEqual({ target: join("/a", "PRSLOY"), legacy: join("/a", "@zeno", "desktop") });
  });
  it("dev builds and --user-data-dir keep Electron's choice", () => {
    expect(
      prsloyUserDataDir({ appData: "/a", packaged: false, explicitUserDataDir: false }),
    ).toBeUndefined();
    expect(
      prsloyUserDataDir({ appData: "/a", packaged: true, explicitUserDataDir: true }),
    ).toBeUndefined();
  });
});

describe("migrateLegacyUserData", () => {
  it("moves the old profile, rewrites paths, re-provisions runtimes", () => {
    const { plan, session } = legacyProfile();
    const result = migrateLegacyUserData(plan);
    expect(result.status).toBe("moved");
    expect(existsSync(plan.legacy)).toBe(false);
    expect(existsSync(join(plan.legacy, ".."))).toBe(false); // empty @zeno removed
    expect(readFileSync(join(plan.target, "prsloy", "gateway-key.bin"), "utf8")).toBe("encrypted");
    const prefs = JSON.parse(readFileSync(join(plan.target, "zeno-desktop.json"), "utf8"));
    expect(prefs.recentSessions[0].sessionFile).toBe(session.replace(plan.legacy, plan.target));
    expect(existsSync(join(plan.target, "runtimes", ".provisioned.json"))).toBe(false);
    expect(existsSync(join(plan.target, "runtimes", "python-venv"))).toBe(false);
    // Second start: nothing to do.
    expect(migrateLegacyUserData(plan).status).toBe("none");
  });

  it("falls back to a copy and marks the old profile when the rename fails", () => {
    const { plan } = legacyProfile();
    const result = migrateLegacyUserData({
      ...plan,
      rename: () => {
        throw new Error("EBUSY");
      },
    });
    expect(result.status).toBe("copied");
    expect(existsSync(join(plan.target, "prsloy", "gateway-key.bin"))).toBe(true);
    expect(existsSync(join(plan.legacy, MIGRATED_MARKER))).toBe(true);
    rmSync(plan.target, { recursive: true, force: true });
    // A marked old profile is never migrated again.
    expect(migrateLegacyUserData(plan).status).toBe("none");
  });

  it("does nothing when the new profile already exists", () => {
    const { plan } = legacyProfile();
    mkdirSync(plan.target, { recursive: true });
    expect(migrateLegacyUserData(plan).status).toBe("none");
    expect(existsSync(plan.legacy)).toBe(true);
  });
});
