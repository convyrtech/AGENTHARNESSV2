import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export type CuaActionKind = "click" | "type_text" | "other";
export type CuaActionOutcome = "confirmed_applied" | "confirmed_not_applied" | "ambiguous";
export type CuaOwnerResolution = "observed_completed" | "observed_not_applied" | "accept_unknown";

export type CuaPendingAction = {
  actionId: string;
  profileId: string;
  hostId: string;
  sessionId: string;
  pid: number;
  windowId: number;
  kind: CuaActionKind;
  status: "dispatching" | "unknown";
  createdAt: number;
};

export type MunimPendingAction = Omit<CuaPendingAction, "windowId"> & {
  backend: "munim";
  windowId: null;
};

/** Cua keeps its historical object shape; Munim is tagged and has no fake HWND. */
export type ComputerUsePendingAction = CuaPendingAction | MunimPendingAction;

type StoredAction = {
  action_id: string;
  profile_id: string;
  host_id: string;
  session_id: string;
  pid: number;
  window_id: number | null;
  backend: string;
  kind: string;
  status: string;
  created_at: number;
};

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) <= 31) return true;
  }
  return false;
}

const LEGACY_SCHEMA_VERSION = 0;
const CURRENT_SCHEMA_VERSION = 2;
const LEGACY_TABLE_SQL = `CREATE TABLE cua_actions (
  action_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  pid INTEGER NOT NULL CHECK (pid > 0),
  window_id INTEGER NOT NULL CHECK (window_id > 0),
  kind TEXT NOT NULL CHECK (kind IN ('click', 'type_text', 'other')),
  status TEXT NOT NULL CHECK (status IN ('dispatching', 'unknown', 'applied', 'not_applied', 'resolved_completed', 'resolved_not_applied', 'accepted_unknown')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`;
const ACTION_COLUMNS = `
  action_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  pid INTEGER NOT NULL CHECK (pid > 0),
  window_id INTEGER CHECK (window_id IS NULL OR window_id > 0),
  backend TEXT NOT NULL DEFAULT 'cua' CHECK (backend IN ('cua', 'munim')),
  kind TEXT NOT NULL CHECK (kind IN ('click', 'type_text', 'other')),
  status TEXT NOT NULL CHECK (status IN ('dispatching', 'unknown', 'applied', 'not_applied', 'resolved_completed', 'resolved_not_applied', 'accepted_unknown')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((backend = 'cua' AND window_id IS NOT NULL AND window_id > 0) OR (backend = 'munim' AND window_id IS NULL))
`;
const CURRENT_TABLE_SQL = `CREATE TABLE cua_actions (${ACTION_COLUMNS})`;
const PENDING_INDEX_SQL = `CREATE UNIQUE INDEX cua_one_pending_action_per_profile
  ON cua_actions(profile_id)
  WHERE status IN ('dispatching', 'unknown')`;
const HISTORY_INDEX_SQL = `CREATE INDEX cua_actions_profile_history
  ON cua_actions(profile_id, created_at DESC)`;

function normalizedSql(sql: string | undefined): string {
  return (sql ?? "")
    .replaceAll('"', "")
    .replaceAll("`", "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

type DatabaseWithConnection = DatabaseSync & { isTransaction?: boolean };

/**
 * Durable, profile-wide Cua side-effect gate. Call `beginDispatch` and wait for
 * its commit before dispatching any native action. Every connection to this
 * database is serialized by SQLite's write lock and the partial unique index.
 * This store deliberately does not dispatch actions or decide that an error
 * means an action did not happen. Schema migration is not an upgrade barrier:
 * older Munim executables that do not consult this store can bypass this gate.
 */
export class CuaRecoveryStore {
  readonly #db: DatabaseWithConnection;
  #closed = false;

  private constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new DatabaseSync(dbPath);
    try {
      this.#db.exec("PRAGMA busy_timeout = 5000");
      // Keep SQLite's default DELETE journal: changing journal mode on each
      // independent process during startup races with an active writer. FULL
      // synchronous applies to every committed intent and state transition.
      this.#db.exec("PRAGMA synchronous = FULL");
      this.#db.exec("PRAGMA foreign_keys = ON");
      this.#initializeSchema();
    } catch (error) {
      try {
        this.#db.close();
      } catch {
        // Preserve the initialization error.
      }
      throw error;
    }
  }

  static open(userDataPath: string): CuaRecoveryStore {
    if (!userDataPath || typeof userDataPath !== "string")
      throw new Error("A durable userData path is required");
    return new CuaRecoveryStore(join(userDataPath, "prsloy", "cua-recovery.sqlite"));
  }

  #initializeSchema(): void {
    this.#transaction(() => {
      const versionRow = this.#db.prepare("PRAGMA user_version").get() as
        | { user_version: number }
        | undefined;
      const version = versionRow?.user_version;
      if (!Number.isSafeInteger(version) || version === undefined)
        throw new Error("Could not read Cua recovery schema version");
      if (version > CURRENT_SCHEMA_VERSION)
        throw new Error(`Unsupported newer Cua recovery schema: ${version}`);
      if (version === CURRENT_SCHEMA_VERSION) {
        this.#validateCurrentSchema();
        return;
      }
      if (version !== LEGACY_SCHEMA_VERSION)
        throw new Error(`Unsupported Cua recovery schema version: ${version}`);

      // Validate even the empty v0 case: a view can exist without a table and
      // would otherwise be silently carried into the newly initialized DB.
      this.#validateNoTriggersOrViews();
      const tables = this.#userTables();
      if (tables.length === 0) {
        this.#createCurrentSchema("cua_actions");
        this.#createIndexes();
        this.#db.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
        return;
      }
      if (tables.length !== 1 || tables[0] !== "cua_actions")
        throw new Error("Unknown unversioned Cua recovery database schema");

      this.#validateLegacySchema();
      // Rebuild in this same IMMEDIATE transaction. Existing rows and IDs are
      // preserved; legacy rows are explicitly tagged Cua and keep their HWND.
      this.#createCurrentSchema("cua_actions_migration");
      this.#db.exec(`
        INSERT INTO cua_actions_migration (
          action_id, profile_id, host_id, session_id, pid, window_id, backend,
          kind, status, created_at, updated_at
        )
        SELECT action_id, profile_id, host_id, session_id, pid, window_id, 'cua',
          kind, status, created_at, updated_at
        FROM cua_actions;
        DROP TABLE cua_actions;
        ALTER TABLE cua_actions_migration RENAME TO cua_actions;
      `);
      this.#createIndexes();
      this.#db.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
      this.#validateCurrentSchema();
    });
  }

  #userTables(): string[] {
    return (
      this.#db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((row) => row.name);
  }

  #validateLegacySchema(): void {
    this.#validateNoTriggersOrViews();
    const table = this.#db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'cua_actions'")
      .get() as { sql: string } | undefined;
    const expectedTable = normalizedSql(LEGACY_TABLE_SQL);
    if (normalizedSql(table?.sql) !== expectedTable)
      throw new Error("Unversioned Cua recovery table does not match the supported legacy schema");
    this.#validateIndex("cua_one_pending_action_per_profile", PENDING_INDEX_SQL);
    this.#validateIndex("cua_actions_profile_history", HISTORY_INDEX_SQL);
  }

  #validateCurrentSchema(): void {
    this.#validateNoTriggersOrViews();
    const table = this.#db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'cua_actions'")
      .get() as { sql: string } | undefined;
    if (normalizedSql(table?.sql) !== normalizedSql(CURRENT_TABLE_SQL))
      throw new Error("Cua recovery table does not match the current schema");
    this.#validateIndex("cua_one_pending_action_per_profile", PENDING_INDEX_SQL);
    this.#validateIndex("cua_actions_profile_history", HISTORY_INDEX_SQL);
  }

  #validateIndex(name: string, expectedSql: string): void {
    const index = this.#db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get(name) as { sql: string } | undefined;
    if (normalizedSql(index?.sql) !== normalizedSql(expectedSql))
      throw new Error(`Cua recovery index is missing or invalid: ${name}`);
  }

  #validateNoTriggersOrViews(): void {
    const unexpected = this.#db
      .prepare("SELECT type, name FROM sqlite_master WHERE type IN ('trigger', 'view') LIMIT 1")
      .get() as { type: string; name: string } | undefined;
    if (unexpected)
      throw new Error(
        `Unexpected Cua recovery schema object: ${unexpected.type} ${unexpected.name}`,
      );
  }

  #createCurrentSchema(tableName: string): void {
    if (tableName !== "cua_actions" && tableName !== "cua_actions_migration")
      throw new Error("Invalid Cua schema table name");
    this.#db.exec(`CREATE TABLE ${tableName} (${ACTION_COLUMNS})`);
  }

  #createIndexes(): void {
    this.#db.exec(PENDING_INDEX_SQL);
    this.#db.exec(HISTORY_INDEX_SQL);
  }

  /**
   * Commit a durable intent before invoking Cua. All IDs are identifiers only;
   * do not pass prompts, typed text, screenshots, credentials or tool output.
   */
  beginDispatch(input: {
    profileId: string;
    hostId: string;
    sessionId: string;
    pid: number;
    windowId: number;
    kind: CuaActionKind;
  }): CuaPendingAction {
    this.#assertOpen();
    this.#assertKeys(input, ["profileId", "hostId", "sessionId", "pid", "windowId", "kind"]);
    this.#validateInput(input);
    return this.#beginDispatch({ ...input, backend: "cua" }) as CuaPendingAction;
  }

  /** Munim targets a process only; never invent an HWND for its PID-only API. */
  beginMunimDispatch(input: {
    profileId: string;
    hostId: string;
    sessionId: string;
    pid: number;
    kind: CuaActionKind;
  }): MunimPendingAction {
    this.#assertOpen();
    this.#assertKeys(input, ["profileId", "hostId", "sessionId", "pid", "kind"]);
    this.#validateIdentity(input);
    if (!Number.isSafeInteger(input.pid) || input.pid <= 0) throw new Error("Invalid pid");
    if (!(["click", "type_text", "other"] as string[]).includes(input.kind))
      throw new Error("Invalid action kind");
    return this.#beginDispatch({
      ...input,
      backend: "munim",
      windowId: null,
    }) as MunimPendingAction;
  }

  #beginDispatch(input: {
    profileId: string;
    hostId: string;
    sessionId: string;
    pid: number;
    windowId: number | null;
    backend: "cua" | "munim";
    kind: CuaActionKind;
  }): ComputerUsePendingAction {
    const action: ComputerUsePendingAction =
      input.backend === "cua"
        ? {
            profileId: input.profileId,
            hostId: input.hostId,
            sessionId: input.sessionId,
            pid: input.pid,
            windowId: input.windowId as number,
            kind: input.kind,
            actionId: randomUUID(),
            status: "dispatching",
            createdAt: Date.now(),
          }
        : {
            backend: "munim",
            profileId: input.profileId,
            hostId: input.hostId,
            sessionId: input.sessionId,
            pid: input.pid,
            windowId: null,
            kind: input.kind,
            actionId: randomUUID(),
            status: "dispatching",
            createdAt: Date.now(),
          };
    this.#transaction(() => {
      const pending = this.#db
        .prepare(
          "SELECT action_id FROM cua_actions WHERE profile_id = ? AND status IN ('dispatching', 'unknown') LIMIT 1",
        )
        .get(input.profileId) as { action_id: string } | undefined;
      if (pending) throw new Error(`CUA_RECOVERY_BLOCKED:${pending.action_id}`);
      this.#db
        .prepare(
          `INSERT INTO cua_actions (action_id, profile_id, host_id, session_id, pid, window_id, backend, kind, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'dispatching', ?, ?)`,
        )
        .run(
          action.actionId,
          action.profileId,
          action.hostId,
          action.sessionId,
          action.pid,
          action.windowId,
          input.backend,
          action.kind,
          action.createdAt,
          action.createdAt,
        );
      const persisted = this.#db
        .prepare(
          `SELECT action_id, profile_id, host_id, session_id, pid, window_id, backend, kind, status, created_at
           FROM cua_actions WHERE action_id = ?`,
        )
        .get(action.actionId) as StoredAction | undefined;
      if (
        !persisted ||
        persisted.action_id !== action.actionId ||
        persisted.profile_id !== action.profileId ||
        persisted.host_id !== action.hostId ||
        persisted.session_id !== action.sessionId ||
        persisted.pid !== action.pid ||
        persisted.window_id !== action.windowId ||
        persisted.backend !== input.backend ||
        persisted.kind !== action.kind ||
        persisted.status !== "dispatching" ||
        persisted.created_at !== action.createdAt
      )
        throw new Error(
          "CUA_RECOVERY_INTENT_NOT_DURABLE: inserted gate record did not persist exactly",
        );
    });
    return action;
  }

  /**
   * Only a backend-specific, explicit result may close the gate. Any transport
   * error, cancellation, timeout, or unclear response must be recorded as
   * `ambiguous`, which leaves the action blocked for owner review.
   */
  recordOutcome(actionId: string, hostId: string, outcome: CuaActionOutcome): void {
    this.#assertOpen();
    if (typeof hostId !== "string" || hostId.length < 1 || hostId.length > 512)
      throw new Error("Invalid host id");
    if (
      outcome !== "confirmed_applied" &&
      outcome !== "confirmed_not_applied" &&
      outcome !== "ambiguous"
    )
      throw new Error("Invalid Cua outcome");
    this.#transaction(() => {
      const next =
        outcome === "confirmed_applied"
          ? "applied"
          : outcome === "confirmed_not_applied"
            ? "not_applied"
            : "unknown";
      const changed = this.#db
        .prepare(
          "UPDATE cua_actions SET status = ?, updated_at = ? WHERE action_id = ? AND host_id = ? AND status = 'dispatching'",
        )
        .run(next, Date.now(), actionId, hostId);
      if (changed.changes !== 1) throw new Error("Action is not dispatching for this host");
    });
  }

  /** Stop/host loss never claims that the external operation was undone. */
  recordAbort(actionId: string, hostId: string): void {
    this.#assertOpen();
    if (typeof hostId !== "string" || hostId.length < 1 || hostId.length > 512)
      throw new Error("Invalid host id");
    this.#transaction(() => {
      const result = this.#db
        .prepare(
          "UPDATE cua_actions SET status = 'unknown', updated_at = ? WHERE action_id = ? AND host_id = ? AND status = 'dispatching'",
        )
        .run(Date.now(), actionId, hostId);
      if (result.changes !== 1) throw new Error("Action is not dispatching");
    });
  }

  /**
   * Mark an action as uncertain after the caller independently establishes
   * that its owning host was lost. This method does not detect host death or
   * infer that an action failed: exact actionId + hostId matching is required,
   * and only an existing `dispatching` row can transition to `unknown`.
   */
  markUnknownAfterHostLoss(actionId: string, hostId: string): void {
    this.#assertOpen();
    if (!/^[0-9a-f-]{36}$/iu.test(actionId)) throw new Error("Invalid action id");
    if (typeof hostId !== "string" || hostId.length < 1 || hostId.length > 512)
      throw new Error("Invalid host id");
    this.#transaction(() => {
      const changed = this.#db
        .prepare(
          "UPDATE cua_actions SET status = 'unknown', updated_at = ? WHERE action_id = ? AND host_id = ? AND status = 'dispatching'",
        )
        .run(Date.now(), actionId, hostId);
      if (changed.changes !== 1)
        throw new Error("Host-loss transition did not match a dispatching action");
    });
  }

  /** Return the unresolved operation that blocks every Cua session in a profile. */
  getPending(profileId: string): ComputerUsePendingAction | undefined {
    this.#assertOpen();
    const row = this.#db
      .prepare(
        `SELECT action_id, profile_id, host_id, session_id, pid, window_id, backend, kind, status, created_at
         FROM cua_actions WHERE profile_id = ? AND status IN ('dispatching', 'unknown') LIMIT 1`,
      )
      .get(profileId) as StoredAction | undefined;
    return row ? this.#publicAction(row) : undefined;
  }

  /** List all unresolved profile gates for a startup recovery UI. */
  listPending(): ComputerUsePendingAction[] {
    this.#assertOpen();
    const rows = this.#db
      .prepare(
        `SELECT action_id, profile_id, host_id, session_id, pid, window_id, backend, kind, status, created_at
         FROM cua_actions WHERE status IN ('dispatching', 'unknown') ORDER BY created_at`,
      )
      .all() as StoredAction[];
    return rows.map((row) => this.#publicAction(row));
  }

  /**
   * Clear an unknown only after a trusted UI has independently verified an
   * explicit owner decision for this exact, still-pending action. The verifier
   * must not be a generic extension confirm or accept synthetic auto-confirm.
   */
  resolveUnknown(
    actionId: string,
    resolution: CuaOwnerResolution,
    verifyOwnerDecision: (action: ComputerUsePendingAction) => boolean,
  ): void {
    this.#assertOpen();
    if (!/^[0-9a-f-]{36}$/iu.test(actionId)) throw new Error("Invalid action id");
    if (!["observed_completed", "observed_not_applied", "accept_unknown"].includes(resolution))
      throw new Error("Invalid owner resolution");
    if (typeof verifyOwnerDecision !== "function")
      throw new Error("Trusted owner decision verifier required");
    this.#transaction(() => {
      const row = this.#getById(actionId);
      if (!row || row.status !== "unknown")
        throw new Error("Action is not awaiting owner resolution");
      let verified = false;
      try {
        verified = verifyOwnerDecision(this.#publicAction(row));
      } catch {
        verified = false;
      }
      if (verified !== true) throw new Error("Owner decision was not verified");
      const next =
        resolution === "observed_completed"
          ? "resolved_completed"
          : resolution === "observed_not_applied"
            ? "resolved_not_applied"
            : "accepted_unknown";
      const update = this.#db
        .prepare(
          "UPDATE cua_actions SET status = ?, updated_at = ? WHERE action_id = ? AND status = 'unknown'",
        )
        .run(next, Date.now(), actionId);
      if (update.changes !== 1) throw new Error("Action changed before owner resolution");
    });
  }

  /** Owner explicitly accepts an in-flight effect may finish after the gate is released. */
  acceptDispatchingRisk(
    actionId: string,
    verifyOwnerDecision: (action: ComputerUsePendingAction) => boolean,
  ): void {
    this.#assertOpen();
    if (!/^[0-9a-f-]{36}$/iu.test(actionId)) throw new Error("Invalid action id");
    if (typeof verifyOwnerDecision !== "function")
      throw new Error("Trusted owner decision verifier required");
    this.#transaction(() => {
      const row = this.#getById(actionId);
      if (!row || row.status !== "dispatching") throw new Error("Action is not dispatching");
      let verified = false;
      try {
        verified = verifyOwnerDecision(this.#publicAction(row));
      } catch {
        verified = false;
      }
      if (verified !== true) throw new Error("Owner decision was not verified");
      const result = this.#db
        .prepare(
          "UPDATE cua_actions SET status = 'accepted_unknown', updated_at = ? WHERE action_id = ? AND status = 'dispatching'",
        )
        .run(Date.now(), actionId);
      if (result.changes !== 1) throw new Error("Action changed before owner decision");
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  #getById(actionId: string): StoredAction | undefined {
    return this.#db
      .prepare(
        `SELECT action_id, profile_id, host_id, session_id, pid, window_id, backend, kind, status, created_at
         FROM cua_actions WHERE action_id = ? LIMIT 1`,
      )
      .get(actionId) as StoredAction | undefined;
  }

  #transaction<T>(callback: () => T): T {
    // BEGIN IMMEDIATE acquires the cross-connection/process writer lock before
    // checking the profile gate; the unique index is the second race guard.
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // A failed SQLite transaction must not turn into an action dispatch.
      }
      throw error;
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Cua recovery store is closed");
  }

  #validateInput(input: {
    profileId: string;
    hostId: string;
    sessionId: string;
    pid: number;
    windowId: number;
    kind: CuaActionKind;
  }): void {
    this.#validateIdentity(input);
    if (!Number.isSafeInteger(input.pid) || input.pid <= 0) throw new Error("Invalid pid");
    if (!Number.isSafeInteger(input.windowId) || input.windowId <= 0)
      throw new Error("Invalid windowId");
    if (!(["click", "type_text", "other"] as string[]).includes(input.kind))
      throw new Error("Invalid action kind");
  }

  #validateIdentity(input: { profileId: string; hostId: string; sessionId: string }): void {
    for (const [key, value] of Object.entries({
      profileId: input.profileId,
      hostId: input.hostId,
      sessionId: input.sessionId,
    })) {
      if (
        typeof value !== "string" ||
        value.length < 1 ||
        value.length > 512 ||
        hasControlCharacter(value)
      )
        throw new Error(`Invalid ${key}`);
    }
  }

  #assertKeys(value: object, allowedKeys: string[]): void {
    if (Object.keys(value).some((key) => !allowedKeys.includes(key)))
      throw new Error("Invalid backend-specific action fields");
  }

  #publicAction(row: StoredAction): ComputerUsePendingAction {
    if (row.status !== "dispatching" && row.status !== "unknown")
      throw new Error("Action is not pending");
    const common: Omit<CuaPendingAction, "windowId"> = {
      actionId: row.action_id,
      profileId: row.profile_id,
      hostId: row.host_id,
      sessionId: row.session_id,
      pid: row.pid,
      kind: row.kind as CuaActionKind,
      status: row.status as CuaPendingAction["status"],
      createdAt: row.created_at,
    };
    if (row.backend === "cua" && row.window_id !== null)
      return { ...common, windowId: row.window_id };
    if (row.backend === "munim" && row.window_id === null)
      return { ...common, backend: "munim", windowId: null };
    throw new Error("Stored computer-use action has invalid backend/window target");
  }
}
