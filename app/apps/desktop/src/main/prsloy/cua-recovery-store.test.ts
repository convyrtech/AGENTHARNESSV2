import { afterEach, describe, expect, it } from "vite-plus/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CuaRecoveryStore } from "./cua-recovery-store.js";

const roots: string[] = [];

function setup() {
  const root = mkdtempSync(join(tmpdir(), "cua-recovery-store-"));
  roots.push(root);
  return { root, open: () => CuaRecoveryStore.open(root) };
}

function createLegacyDatabase(root: string, alterSchema = false): DatabaseSync {
  const dbPath = join(root, "prsloy", "cua-recovery.sqlite");
  mkdirSync(join(root, "prsloy"), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE cua_actions (
      action_id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      host_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      pid INTEGER NOT NULL CHECK (pid > 0),
      window_id INTEGER NOT NULL CHECK (window_id > 0),
      kind TEXT NOT NULL CHECK (kind IN ('click', 'type_text', 'other')),
      status TEXT NOT NULL CHECK (status IN ('dispatching', 'unknown', 'applied', 'not_applied', 'resolved_completed', 'resolved_not_applied', 'accepted_unknown')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL${alterSchema ? ",\n      unexpected TEXT" : ""}
    );
    CREATE UNIQUE INDEX cua_one_pending_action_per_profile
      ON cua_actions(profile_id)
      WHERE status IN ('dispatching', 'unknown');
    CREATE INDEX cua_actions_profile_history
      ON cua_actions(profile_id, created_at DESC);
  `);
  return db;
}

function begin(store: CuaRecoveryStore, profileId = "profile-a") {
  return store.beginDispatch({
    profileId,
    hostId: "host-1",
    sessionId: "session-1",
    pid: 1234,
    windowId: 5678,
    kind: "click",
  });
}

function childBegin(
  root: string,
  hostId: string,
  backend: "cua" | "munim" = "cua",
): Promise<string> {
  const moduleUrl = new URL("./cua-recovery-store.ts", import.meta.url).href;
  const source = `
    import { CuaRecoveryStore } from ${JSON.stringify(moduleUrl)};
    const [root, hostId, backend] = process.argv.slice(1);
    const store = CuaRecoveryStore.open(root);
    try {
      const action = backend === "munim"
        ? store.beginMunimDispatch({ profileId: "shared-profile", hostId, sessionId: hostId, pid: 1, kind: "click" })
        : store.beginDispatch({ profileId: "shared-profile", hostId, sessionId: hostId, pid: 1, windowId: 1, kind: "click" });
      process.stdout.write("began:" + action.actionId);
    } catch (error) {
      process.stdout.write(String(error?.message ?? error));
    } finally { store.close(); }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", source, root, hostId, backend],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(stderr || `child exited ${code}`)),
    );
  });
}

function childOpen(root: string): Promise<void> {
  const moduleUrl = new URL("./cua-recovery-store.ts", import.meta.url).href;
  const source = `
    import { CuaRecoveryStore } from ${JSON.stringify(moduleUrl)};
    const store = CuaRecoveryStore.open(process.argv[1]);
    store.close();
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", source, root],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(stderr || `child exited ${code}`)),
    );
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("CuaRecoveryStore", () => {
  it("writes intent before dispatch, recovers it after close/reopen and blocks a blind retry", () => {
    const { open } = setup();
    const first = open();
    const action = begin(first);
    expect(first.getPending("profile-a")).toMatchObject({
      actionId: action.actionId,
      status: "dispatching",
    });
    first.close(); // models main/host loss before recording a tool result

    const restarted = open();
    expect(restarted.getPending("profile-a")).toMatchObject({
      actionId: action.actionId,
      status: "dispatching",
    });
    expect(() => begin(restarted)).toThrow(new RegExp(`CUA_RECOVERY_BLOCKED:${action.actionId}`));
    expect(() => begin(restarted, "another-profile")).not.toThrow();
    restarted.close();
  });

  it("serializes Cua and Munim dispatches from independent OS processes against one profile", async () => {
    const { root, open } = setup();
    const results = await Promise.all([
      childBegin(root, "host-cua", "cua"),
      childBegin(root, "host-munim", "munim"),
    ]);
    expect(results.filter((result) => result.startsWith("began:"))).toHaveLength(1);
    expect(
      results.filter(
        (result) =>
          result.startsWith("CUA_RECOVERY_BLOCKED:") || result === "Action blocked by unique index",
      ),
    ).toHaveLength(1);
    const store = open();
    const pending = store.getPending("shared-profile");
    expect(pending).toBeDefined();
    if (pending && "backend" in pending && pending.backend === "munim")
      expect(pending.windowId).toBeNull();
    else if (pending) expect(pending.windowId).toBeGreaterThan(0);
    store.close();
  });

  it("migrates the unversioned database once and preserves pending/resolved Cua rows", () => {
    const { root, open } = setup();
    const legacy = createLegacyDatabase(root);
    const pendingId = "3f20e3b6-68d7-4e9f-9fc2-12967de60bf6";
    const resolvedId = "b3b82288-816e-4421-8eba-e6e07758e701";
    legacy
      .prepare(
        "INSERT INTO cua_actions VALUES (?, 'profile-a', 'host-legacy', 'session-legacy', 9, 10, 'click', ?, 11, 12)",
      )
      .run(pendingId, "unknown");
    legacy
      .prepare(
        "INSERT INTO cua_actions VALUES (?, 'profile-a', 'host-legacy', 'session-legacy', 9, 10, 'click', ?, 13, 14)",
      )
      .run(resolvedId, "resolved_completed");
    legacy.close();

    const migrated = open();
    const pending = migrated.getPending("profile-a");
    expect(pending).toMatchObject({ actionId: pendingId, pid: 9, windowId: 10, status: "unknown" });
    expect(pending && "backend" in pending).toBe(false); // Cua keeps its old public shape.
    expect(() => begin(migrated)).toThrow(/CUA_RECOVERY_BLOCKED/);
    migrated.close();

    const db = new DatabaseSync(join(root, "prsloy", "cua-recovery.sqlite"));
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(
      2,
    );
    expect(
      db
        .prepare("SELECT action_id, backend, window_id, status FROM cua_actions ORDER BY action_id")
        .all(),
    ).toEqual([
      {
        action_id: pendingId,
        backend: "cua",
        window_id: 10,
        status: "unknown",
      },
      {
        action_id: resolvedId,
        backend: "cua",
        window_id: 10,
        status: "resolved_completed",
      },
    ]);
    db.close();

    const reopened = open();
    expect(reopened.getPending("profile-a")).toMatchObject({
      actionId: pendingId,
      status: "unknown",
    });
    reopened.close();
  });

  it("serializes concurrent legacy schema migrations across independent processes", async () => {
    const { root } = setup();
    const legacy = createLegacyDatabase(root);
    legacy.close();
    await Promise.all([childOpen(root), childOpen(root)]);
    const db = new DatabaseSync(join(root, "prsloy", "cua-recovery.sqlite"));
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(
      2,
    );
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'cua_one_pending_action_per_profile'",
        )
        .get(),
    ).toBeDefined();
    db.close();
  });

  it("rejects unknown or newer schemas without changing them", () => {
    const { root, open } = setup();
    const db = createLegacyDatabase(root, true);
    db.prepare(
      "INSERT INTO cua_actions VALUES (?, 'profile-a', 'h', 's', 1, 2, 'click', 'unknown', 1, 1, 'preserve')",
    ).run("7a636a1b-a7a5-4e6c-817f-02c0ace34f45");
    db.close();
    expect(() => open()).toThrow(/does not match the supported legacy schema/);
    const unchanged = new DatabaseSync(join(root, "prsloy", "cua-recovery.sqlite"));
    expect(
      (unchanged.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    ).toBe(0);
    expect(
      (unchanged.prepare("SELECT unexpected FROM cua_actions").get() as { unexpected: string })
        .unexpected,
    ).toBe("preserve");
    unchanged.close();

    const newerRoot = mkdtempSync(join(tmpdir(), "cua-recovery-newer-"));
    roots.push(newerRoot);
    mkdirSync(join(newerRoot, "prsloy"), { recursive: true });
    const newerDb = new DatabaseSync(join(newerRoot, "prsloy", "cua-recovery.sqlite"));
    newerDb.exec("PRAGMA user_version = 99");
    newerDb.close();
    expect(() => CuaRecoveryStore.open(newerRoot)).toThrow(/newer Cua recovery schema: 99/);
    const verifyNewer = new DatabaseSync(join(newerRoot, "prsloy", "cua-recovery.sqlite"));
    expect(
      (verifyNewer.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    ).toBe(99);
    verifyNewer.close();
  });

  it("rejects malicious current-schema triggers and verifies the inserted gate before returning", () => {
    const { root, open } = setup();
    const store = open();
    const db = new DatabaseSync(join(root, "prsloy", "cua-recovery.sqlite"));
    db.exec(`
      CREATE TRIGGER remove_new_pending AFTER INSERT ON cua_actions
      BEGIN DELETE FROM cua_actions WHERE action_id = NEW.action_id; END;
    `);
    db.close();

    // Simulates a trigger added after open: begin must not report success if
    // the committed intent is removed or changed by SQL-side behavior.
    expect(() => begin(store)).toThrow(/CUA_RECOVERY_INTENT_NOT_DURABLE/);
    expect(store.getPending("profile-a")).toBeUndefined();
    store.close();
    expect(() => open()).toThrow(
      /Unexpected Cua recovery schema object: trigger remove_new_pending/,
    );
  });

  it("rejects triggers on the exact legacy schema before running migration", () => {
    const { root, open } = setup();
    const legacy = createLegacyDatabase(root);
    legacy.exec(`
      CREATE TRIGGER legacy_side_effect AFTER INSERT ON cua_actions
      BEGIN DELETE FROM cua_actions WHERE action_id = NEW.action_id; END;
    `);
    legacy.close();

    expect(() => open()).toThrow(
      /Unexpected Cua recovery schema object: trigger legacy_side_effect/,
    );
    const db = new DatabaseSync(join(root, "prsloy", "cua-recovery.sqlite"));
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(
      0,
    );
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cua_actions_migration'",
        )
        .get(),
    ).toBeUndefined();
    db.close();
  });

  it("rejects a v0 database with a view before creating any recovery tables", () => {
    const { root } = setup();
    mkdirSync(join(root, "prsloy"), { recursive: true });
    const dbPath = join(root, "prsloy", "cua-recovery.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE VIEW unexpected_view AS SELECT 1 AS value");
    db.close();

    expect(() => CuaRecoveryStore.open(root)).toThrow(
      /Unexpected Cua recovery schema object: view unexpected_view/,
    );
    const unchanged = new DatabaseSync(dbPath);
    expect(
      (unchanged.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    ).toBe(0);
    expect(
      unchanged
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cua_actions'")
        .get(),
    ).toBeUndefined();
    expect(
      unchanged
        .prepare("SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'unexpected_view'")
        .get(),
    ).toBeDefined();
    unchanged.close();
  });

  it("uses null HWND only for Munim and rejects invalid backend/target combinations", () => {
    const store = setup().open();
    const munim = store.beginMunimDispatch({
      profileId: "profile-a",
      hostId: "host-munim",
      sessionId: "session-munim",
      pid: 22,
      kind: "type_text",
    });
    expect(munim).toMatchObject({ backend: "munim", pid: 22, windowId: null });
    store.recordAbort(munim.actionId, munim.hostId);
    store.resolveUnknown(
      munim.actionId,
      "accept_unknown",
      (action) => "backend" in action && action.backend === "munim",
    );

    expect(() =>
      store.beginMunimDispatch({
        profileId: "profile-a",
        hostId: "h",
        sessionId: "s",
        pid: 22,
        kind: "click",
        windowId: 44,
      } as never),
    ).toThrow(/backend-specific action fields/);
    expect(() =>
      store.beginDispatch({
        profileId: "profile-a",
        hostId: "h",
        sessionId: "s",
        pid: 22,
        kind: "click",
        windowId: null,
      } as never),
    ).toThrow(/Invalid windowId/);
    expect(() =>
      store.beginDispatch({
        profileId: "profile-a",
        hostId: "h",
        sessionId: "s",
        pid: 22,
        kind: "click",
        windowId: 44,
        backend: "munim",
      } as never),
    ).toThrow(/backend-specific action fields/);
    store.close();
  });

  it("defaults explicit-column SQL inserts that omit backend to Cua", () => {
    const { root, open } = setup();
    const initialized = open();
    initialized.close();
    const db = new DatabaseSync(join(root, "prsloy", "cua-recovery.sqlite"));
    db.prepare(
      `INSERT INTO cua_actions (
        action_id, profile_id, host_id, session_id, pid, window_id, kind, status, created_at, updated_at
      ) VALUES (?, 'legacy-sql', 'host-sql', 'session-sql', 33, 44, 'click', 'unknown', 1, 1)`,
    ).run("1d5d8a23-4850-4ca5-b173-98c640e9f9a8");
    expect(
      db.prepare("SELECT backend FROM cua_actions WHERE profile_id = 'legacy-sql'").get(),
    ).toEqual({ backend: "cua" });
    db.close();
    const reopened = open();
    expect(reopened.getPending("legacy-sql")).toMatchObject({
      actionId: "1d5d8a23-4850-4ca5-b173-98c640e9f9a8",
      windowId: 44,
    });
    reopened.close();

    // Positional INSERT from the old schema has a fixed column count and is
    // not SQL-compatible after adding the backend column; callers must name
    // columns to benefit from DEFAULT 'cua'.
    const positional = new DatabaseSync(join(root, "prsloy", "cua-recovery.sqlite"));
    expect(() =>
      positional
        .prepare(
          "INSERT INTO cua_actions VALUES (?, 'positional', 'h', 's', 1, 2, 'click', 'unknown', 1, 1)",
        )
        .run("4ee57fe1-31da-4d54-82e5-edfdcda1d14e"),
    ).toThrow();
    positional.close();
  });

  it("retains the committed intent when its process is killed without cleanup", async () => {
    const { root, open } = setup();
    const moduleUrl = new URL("./cua-recovery-store.ts", import.meta.url).href;
    const source = `
      import { CuaRecoveryStore } from ${JSON.stringify(moduleUrl)};
      const store = CuaRecoveryStore.open(process.argv[1]);
      const action = store.beginDispatch({ profileId: "profile-a", hostId: "dead-host", sessionId: "s", pid: 1, windowId: 1, kind: "click" });
      process.stdout.write(action.actionId + "\\n");
      setInterval(() => {}, 1000);
    `;
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", source, root],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const actionId = await new Promise<string>((resolve, reject) => {
      child.stdout.once("data", (data: Buffer) => resolve(data.toString().trim()));
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`child exited before intent: ${code}`)));
    });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill();
    await exited;
    const restarted = open();
    expect(restarted.getPending("profile-a")).toMatchObject({ actionId, status: "dispatching" });
    expect(() => begin(restarted)).toThrow(/CUA_RECOVERY_BLOCKED/);
    restarted.close();
  });

  it("keeps ambiguous tool errors and Stop unresolved until explicit owner resolution", () => {
    const { open } = setup();
    const first = open();
    const action = begin(first);
    first.recordOutcome(action.actionId, action.hostId, "ambiguous");
    expect(first.getPending("profile-a")).toMatchObject({
      actionId: action.actionId,
      status: "unknown",
    });
    first.close();

    const restarted = open();
    const pending = restarted.getPending("profile-a");
    expect(pending).toMatchObject({ actionId: action.actionId, status: "unknown" });
    expect(() => begin(restarted)).toThrow(/CUA_RECOVERY_BLOCKED/);
    expect(() =>
      restarted.resolveUnknown(action.actionId, "observed_not_applied", () => false),
    ).toThrow(/not verified/);
    expect(() =>
      restarted.resolveUnknown(
        "00000000-0000-4000-8000-000000000000",
        "observed_not_applied",
        () => true,
      ),
    ).toThrow(/awaiting owner resolution/);
    restarted.resolveUnknown(
      action.actionId,
      "observed_completed",
      (candidate) => candidate.actionId === action.actionId && candidate.status === "unknown",
    );
    expect(restarted.getPending("profile-a")).toBeUndefined();
    // Resolution does not replay the unknown action; an independent action is needed.
    expect(begin(restarted).actionId).not.toBe(action.actionId);
    restarted.close();
  });

  it("closes only on explicit determinate backend outcomes", () => {
    const { open } = setup();
    const store = open();
    const action = begin(store);
    expect(() => store.recordOutcome(action.actionId, action.hostId, "ambiguous")).not.toThrow();
    expect(() => store.recordOutcome(action.actionId, action.hostId, "confirmed_applied")).toThrow(
      /not dispatching/,
    );
    expect(() => begin(store)).toThrow(/CUA_RECOVERY_BLOCKED/);
    store.close();

    const second = open();
    second.resolveUnknown(
      action.actionId,
      "accept_unknown",
      (candidate) => candidate.actionId === action.actionId,
    );
    const other = begin(second);
    second.recordOutcome(other.actionId, other.hostId, "confirmed_not_applied");
    expect(second.getPending("profile-a")).toBeUndefined();
    const third = begin(second);
    second.recordAbort(third.actionId, third.hostId);
    expect(second.getPending("profile-a")).toMatchObject({
      actionId: third.actionId,
      status: "unknown",
    });
    second.close();
  });

  it("rejects stale owner decisions after an action has already been resolved", () => {
    const store = setup().open();
    const action = begin(store);
    store.recordAbort(action.actionId, action.hostId);
    store.resolveUnknown(
      action.actionId,
      "accept_unknown",
      (candidate) => candidate.actionId === action.actionId,
    );
    expect(() => store.resolveUnknown(action.actionId, "accept_unknown", () => true)).toThrow(
      /awaiting owner resolution/,
    );
    store.close();
  });

  it("only releases a still-dispatching action after explicit risk acceptance", () => {
    const store = setup().open();
    const action = begin(store);
    expect(() => store.acceptDispatchingRisk(action.actionId, () => false)).toThrow(/not verified/);
    expect(store.getPending("profile-a")).toMatchObject({ status: "dispatching" });
    store.acceptDispatchingRisk(
      action.actionId,
      (candidate) => candidate.actionId === action.actionId && candidate.status === "dispatching",
    );
    expect(store.getPending("profile-a")).toBeUndefined();
    expect(() => store.acceptDispatchingRisk(action.actionId, () => true)).toThrow(
      /not dispatching/,
    );
    store.close();
  });

  it("keeps a new gate when an explicitly overridden native dispatch completes late", () => {
    const store = setup().open();
    const oldAction = begin(store);

    // The host may have committed intent but not started the native call yet.
    // Owner acceptance releases the gate; it does not cancel or fence that call.
    store.acceptDispatchingRisk(
      oldAction.actionId,
      (candidate) => candidate.actionId === oldAction.actionId,
    );
    const newAction = begin(store);
    expect(store.getPending("profile-a")).toMatchObject({
      actionId: newAction.actionId,
      status: "dispatching",
    });

    // If the old native call starts and reports late, its already-closed row
    // cannot close or rewrite the newer action's pending gate.
    expect(() =>
      store.recordOutcome(oldAction.actionId, oldAction.hostId, "confirmed_applied"),
    ).toThrow(/not dispatching/);
    expect(store.getPending("profile-a")).toMatchObject({
      actionId: newAction.actionId,
      status: "dispatching",
    });
    store.close();
  });

  it("marks host loss only by exact action and host, and ignores a late finish after recovery", () => {
    const store = setup().open();
    const first = begin(store);
    expect(() =>
      store.recordOutcome(first.actionId, "different-host", "confirmed_applied"),
    ).toThrow(/not dispatching for this host/);
    expect(() => store.recordAbort(first.actionId, "different-host")).toThrow(/not dispatching/);
    expect(store.getPending("profile-a")).toMatchObject({
      actionId: first.actionId,
      status: "dispatching",
    });
    expect(() => store.markUnknownAfterHostLoss(first.actionId, "different-host")).toThrow(
      /did not match/,
    );
    expect(store.getPending("profile-a")).toMatchObject({
      actionId: first.actionId,
      status: "dispatching",
    });

    // The caller has established host loss; this CAS marks uncertainty but
    // does not assert whether the external effect happened.
    store.markUnknownAfterHostLoss(first.actionId, first.hostId);
    expect(store.getPending("profile-a")).toMatchObject({
      actionId: first.actionId,
      status: "unknown",
    });
    expect(() => store.recordOutcome(first.actionId, first.hostId, "confirmed_applied")).toThrow(
      /not dispatching/,
    );

    store.resolveUnknown(
      first.actionId,
      "observed_completed",
      (action) => action.actionId === first.actionId,
    );
    const next = begin(store);
    expect(next.actionId).not.toBe(first.actionId);
    // A stale result from the old host cannot close the new action's gate.
    expect(() =>
      store.recordOutcome(first.actionId, first.hostId, "confirmed_not_applied"),
    ).toThrow(/not dispatching/);
    expect(store.getPending("profile-a")).toMatchObject({
      actionId: next.actionId,
      status: "dispatching",
    });
    store.close();
  });

  it("fails closed when the database cannot be opened or written", () => {
    const root = mkdtempSync(join(tmpdir(), "cua-recovery-invalid-"));
    roots.push(root);
    const badDbPath = join(root, "prsloy", "cua-recovery.sqlite");
    mkdirSync(join(root, "prsloy"), { recursive: true });
    writeFileSync(badDbPath, "not a sqlite db");
    expect(() => CuaRecoveryStore.open(root)).toThrow();
  });
});
