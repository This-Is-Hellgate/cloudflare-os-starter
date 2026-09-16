// Task-runtime storage: SQLite DDL and typed executors for the durable task capability.
//
// Schema discipline (plan §4.3):
//  - Every table carries its owning task/account scope and the schema version stamps forward
//    migrations; nothing is ever dropped in the same change that introduces its replacement.
//  - Explicit indexes for (task_id, created_at) style scans; unique keys enforce exactly-once
//    logical admission (task + occurrence/callback id) and idempotent reservation settlement.
//  - Execution takes a `SqlLike` so the DO passes `ctx.storage.sql` and unit tests can substitute
//    a fixture; the SQL here is plain SQLite (Workers DO SQLite dialect).

export interface SqlLike {
  exec<T = Record<string, unknown>>(query: string, ...params: unknown[]): { toArray(): T[] };
}

export const SCHEMA_VERSION = 1;

/** The forward-migration set. Never drop tables/columns here; add additive migrations only. */
export const MIGRATIONS: { version: number; statements: string[] }[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        limits_json TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS grant_versions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        binding TEXT NOT NULL,
        resource TEXT NOT NULL,
        methods_json TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        max_calls INTEGER NOT NULL,
        max_writes INTEGER NOT NULL,
        max_cost_microusd INTEGER,
        installed_at INTEGER NOT NULL,
        installed_by TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_grants_task ON grant_versions (task_id, installed_at)`,
      `CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        logical_key TEXT NOT NULL UNIQUE,
        epoch INTEGER NOT NULL,
        admitted_at INTEGER NOT NULL,
        status TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_runs_task ON runs (task_id, admitted_at)`,
      `CREATE TABLE IF NOT EXISTS reservations (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        grant_id TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        reserved_calls INTEGER NOT NULL,
        reserved_writes INTEGER NOT NULL,
        reserved_cost_microusd INTEGER,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_reservations_grant ON reservations (grant_id, status)`,
      `CREATE TABLE IF NOT EXISTS evidence (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        run_id TEXT,
        kind TEXT NOT NULL,
        origin TEXT NOT NULL,
        resource TEXT,
        observed_at INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        content TEXT,
        ref TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_evidence_task ON evidence (task_id, observed_at)`,
      `CREATE TABLE IF NOT EXISTS checkpoints (
        task_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (task_id, run_id, created_at)
      )`,
      `CREATE TABLE IF NOT EXISTS action_links (
        task_id TEXT NOT NULL,
        action_id INTEGER NOT NULL,
        gatekeeper_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        linked_at INTEGER NOT NULL,
        PRIMARY KEY (task_id, gatekeeper_id, action_id)
      )`,
      `CREATE TABLE IF NOT EXISTS schedules (
        task_id TEXT NOT NULL,
        schedule_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        timezone TEXT,
        awaiting_enablement INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (task_id, schedule_id)
      )`,
      `CREATE TABLE IF NOT EXISTS children (
        child_task_id TEXT PRIMARY KEY,
        parent_task_id TEXT NOT NULL,
        grant_id TEXT NOT NULL,
        profile TEXT NOT NULL,
        requested_at INTEGER NOT NULL,
        finished_at INTEGER,
        result_json TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_children_parent ON children (parent_task_id, requested_at)`,
      `CREATE TABLE IF NOT EXISTS experiments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        config_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        result_json TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        run_id TEXT,
        action_gatekeeper TEXT,
        action_id INTEGER,
        attempt INTEGER,
        policy_version TEXT,
        payload_digest TEXT,
        actor TEXT NOT NULL,
        kind TEXT NOT NULL,
        at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_audit_task ON audit_events (task_id, at)`,
    ],
  },
];

/** Applies migrations forward-only and stamps the schema version. Idempotent. */
export function migrate(sql: SqlLike): number {
  sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const current = sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'schema_version'`).toArray()[0];
  const from = current ? Number(current.value) : 0;
  for (const migration of MIGRATIONS) {
    if (migration.version <= from) continue;
    for (const statement of migration.statements) sql.exec(statement);
    sql.exec(`INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, String(migration.version));
  }
  return SCHEMA_VERSION;
}

/** Generic row helpers with named parameter binding kept literal and reviewable. */
export class TaskStorage {
  constructor(private readonly sql: SqlLike) {}

  #one<T>(query: string, ...params: unknown[]): T | undefined {
    return this.sql.exec<T>(query, ...params).toArray()[0];
  }

  #run(query: string, ...params: unknown[]): void {
    this.sql.exec(query, ...params);
  }

  upsertTask(task: { id: string; title: string; status: string; ownerId: string; workspaceId: string; createdAt: number; expiresAt: number; limitsJson: string }): void {
    this.#run(
      `INSERT INTO tasks (id, title, status, owner_id, workspace_id, created_at, expires_at, limits_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET title = excluded.title, status = excluded.status, expires_at = excluded.expires_at`,
      task.id, task.title, task.status, task.ownerId, task.workspaceId, task.createdAt, task.expiresAt, task.limitsJson,
    );
  }

  getTask(id: string) {
    return this.#one<{ id: string; title: string; status: string; owner_id: string; workspace_id: string; created_at: number; expires_at: number; limits_json: string }>(
      `SELECT * FROM tasks WHERE id = ?`, id);
  }

  setTaskStatus(id: string, status: string): void {
    this.#run(`UPDATE tasks SET status = ? WHERE id = ?`, status, id);
  }

  insertGrant(grant: { id: string; taskId: string; ownerId: string; workspaceId: string; binding: string; resource: string; methodsJson: string; policyVersion: string; expiresAt: number; maxCalls: number; maxWrites: number; maxCostMicrousd: number | null; installedAt: number; installedBy: string }): void {
    this.#run(
      `INSERT INTO grant_versions (id, task_id, owner_id, workspace_id, binding, resource, methods_json, policy_version, expires_at, max_calls, max_writes, max_cost_microusd, installed_at, installed_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      grant.id, grant.taskId, grant.ownerId, grant.workspaceId, grant.binding, grant.resource, grant.methodsJson, grant.policyVersion, grant.expiresAt, grant.maxCalls, grant.maxWrites, grant.maxCostMicrousd, grant.installedAt, grant.installedBy,
    );
  }

  grantsForTask(taskId: string) {
    return this.sql.exec<{ id: string; binding: string; resource: string; methods_json: string; policy_version: string; expires_at: number; max_calls: number; max_writes: number; max_cost_microusd: number | null }>(
      `SELECT id, binding, resource, methods_json, policy_version, expires_at, max_calls, max_writes, max_cost_microusd FROM grant_versions WHERE task_id = ? ORDER BY installed_at`, taskId).toArray();
  }

  /** Exactly-once admission: the unique logical_key makes the INSERT the atomic test-and-set. */
  admitRun(taskId: string, logicalKey: string, runId: string, epoch: number): "admitted" | "duplicate" {
    try {
      this.#run(`INSERT INTO runs (id, task_id, logical_key, epoch, admitted_at, status) VALUES (?, ?, ?, ?, ?, 'admitted')`, runId, taskId, logicalKey, epoch, Date.now());
      return "admitted";
    } catch {
      return "duplicate";
    }
  }

  insertReservation(reservation: { id: string; runId: string; grantId: string; epoch: number; reservedCalls: number; reservedWrites: number; reservedCostMicrousd: number | null }): void {
    this.#run(
      `INSERT INTO reservations (id, run_id, grant_id, epoch, reserved_calls, reserved_writes, reserved_cost_microusd, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'held', ?)`,
      reservation.id, reservation.runId, reservation.grantId, reservation.epoch, reservation.reservedCalls, reservation.reservedWrites, reservation.reservedCostMicrousd, Date.now(),
    );
  }

  reservationsForGrant(grantId: string) {
    return this.sql.exec<{ id: string; reserved_calls: number; reserved_writes: number; reserved_cost_microusd: number | null; status: string }>(
      `SELECT id, reserved_calls, reserved_writes, reserved_cost_microusd, status FROM reservations WHERE grant_id = ? AND status IN ('held', 'retained')`, grantId).toArray();
  }

  setReservationStatus(id: string, status: string): void {
    this.#run(`UPDATE reservations SET status = ? WHERE id = ?`, status, id);
  }

  appendEvidence(evidence: { id: string; taskId: string; runId: string | null; kind: string; origin: string; resource: string | null; observedAt: number; contentHash: string; content: string | null; ref: string | null }): void {
    this.#run(
      `INSERT INTO evidence (id, task_id, run_id, kind, origin, resource, observed_at, content_hash, content, ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      evidence.id, evidence.taskId, evidence.runId, evidence.kind, evidence.origin, evidence.resource, evidence.observedAt, evidence.contentHash, evidence.content, evidence.ref,
    );
  }

  listEvidence(taskId: string) {
    return this.sql.exec<{ id: string; kind: string; origin: string; observed_at: number; content_hash: string }>(
      `SELECT id, kind, origin, observed_at, content_hash FROM evidence WHERE task_id = ? ORDER BY observed_at`, taskId).toArray();
  }

  checkpoint(taskId: string, runId: string, payload: string): void {
    this.#run(`INSERT INTO checkpoints (task_id, run_id, created_at, payload) VALUES (?, ?, ?, ?)`, taskId, runId, Date.now(), payload);
  }

  latestCheckpoint(taskId: string) {
    return this.#one<{ payload: string; created_at: number }>(`SELECT payload, created_at FROM checkpoints WHERE task_id = ? ORDER BY created_at DESC`, taskId);
  }

  linkAction(taskId: string, gatekeeperId: string, accountId: string, actionId: number): void {
    this.#run(`INSERT OR IGNORE INTO action_links (task_id, action_id, gatekeeper_id, account_id, linked_at) VALUES (?, ?, ?, ?, ?)`, taskId, actionId, gatekeeperId, accountId, Date.now());
  }

  listActions(taskId: string) {
    return this.sql.exec<{ gatekeeper_id: string; account_id: string; action_id: number }>(
      `SELECT gatekeeper_id, account_id, action_id FROM action_links WHERE task_id = ? ORDER BY linked_at`, taskId).toArray();
  }

  upsertSchedule(schedule: { taskId: string; scheduleId: string; kind: string; timezone: string | null; awaitingEnablement: boolean }): void {
    this.#run(
      `INSERT INTO schedules (task_id, schedule_id, kind, timezone, awaiting_enablement, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (task_id, schedule_id) DO UPDATE SET awaiting_enablement = excluded.awaiting_enablement, kind = excluded.kind`,
      schedule.taskId, schedule.scheduleId, schedule.kind, schedule.timezone, schedule.awaitingEnablement ? 1 : 0, Date.now(),
    );
  }

  insertChild(child: { childTaskId: string; parentTaskId: string; grantId: string; profile: string; requestedAt: number }): void {
    this.#run(`INSERT INTO children (child_task_id, parent_task_id, grant_id, profile, requested_at) VALUES (?, ?, ?, ?, ?)`, child.childTaskId, child.parentTaskId, child.grantId, child.profile, child.requestedAt);
  }

  finishChild(childTaskId: string, resultJson: string): void {
    this.#run(`UPDATE children SET finished_at = ?, result_json = ? WHERE child_task_id = ?`, Date.now(), resultJson, childTaskId);
  }

  listChildren(parentTaskId: string) {
    return this.sql.exec<{ child_task_id: string; grant_id: string; profile: string; requested_at: number; finished_at: number | null; result_json: string | null }>(
      `SELECT child_task_id, grant_id, profile, requested_at, finished_at, result_json FROM children WHERE parent_task_id = ? ORDER BY requested_at`, parentTaskId).toArray();
  }

  audit(event: { id: string; taskId: string; runId: string | null; actionGatekeeper: string | null; actionId: number | null; attempt: number | null; policyVersion: string | null; payloadDigest: string | null; actor: string; kind: string }): void {
    this.#run(
      `INSERT INTO audit_events (id, task_id, run_id, action_gatekeeper, action_id, attempt, policy_version, payload_digest, actor, kind, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      event.id, event.taskId, event.runId, event.actionGatekeeper, event.actionId, event.attempt, event.policyVersion, event.payloadDigest, event.actor, event.kind, Date.now(),
    );
  }
}
