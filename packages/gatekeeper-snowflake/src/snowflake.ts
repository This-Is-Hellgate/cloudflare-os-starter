import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type {
  AccountDescription, ActionDescription, ApprovalQueue, Gatekeeper, GatekeeperConnectCallback,
  GatekeeperConnectOptions, GatekeeperUser, GatekeeperUserVerifier, ResourceDescription,
  SupportedResource, VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type {
  SnowflakeAccount as SnowflakeAccountInfo, DatabaseSummary, SchemaSummary, TableSummary, TableDescription,
  ColumnDescription, SnowflakeCursor, ReadOnlySqlOptions, ReadOnlySqlResult,
  CortexAnalystRequest, CortexAnalystResult, CortexSearchRequest, CortexSearchResult,
  CortexAgentRequest, CortexAgentResult, CustomToolSummary, CustomToolRequest, CustomToolResult,
  SnowflakeWriteProposal,
  SnowflakeSession,
} from "./types.js";
import TYPES_CODE from "./types-code.js";

const RESOURCE: SupportedResource = {
  urlPattern: "snowflake://account/*",
  title: "Snowflake account capability",
  description: "Scoped Snowflake metadata, bounded SQL, Cortex, and approved tool access.",
  grantable: true,
};
const ICON = { url: "https://www.snowflake.com/wp-content/uploads/2022/03/cropped-snowflake.png" };
const MAX_SQL = 32_000;
const DEFAULT_ROWS = 1000;
const DEFAULT_BYTES = 2_000_000;
const boundedInt = (v: number | undefined, fallback: number, max: number) => {
  const n = v ?? fallback;
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error("Requested limit is outside the allowed bound.");
  return n;
};

function config(env: Env) {
  if (!env.SNOWFLAKE_TOKEN || !env.SNOWFLAKE_ACCOUNT || !env.SNOWFLAKE_ROLE) throw new Error("Snowflake credentials are not configured.");
  const allow = (raw?: string) => new Set((raw ?? "").split(",").map(x => x.trim().toUpperCase()).filter(Boolean));
  return { databases: allow(env.SNOWFLAKE_DATABASES), schemas: allow(env.SNOWFLAKE_SCHEMAS), tables: allow(env.SNOWFLAKE_TABLES), maxRows: Number(env.SNOWFLAKE_MAX_ROWS ?? DEFAULT_ROWS), maxBytes: Number(env.SNOWFLAKE_MAX_BYTES ?? DEFAULT_BYTES) };
}
function identifier(value: string, label: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(value)) throw new Error(`Invalid ${label}.`);
  return value.toUpperCase();
}
function qualified(db: string, schema: string, table?: string): string {
  const d = identifier(db, "database"), s = identifier(schema, "schema");
  return table === undefined ? `${d}.${s}` : `${d}.${s}.${identifier(table, "table")}`;
}
function allowed(set: Set<string>, value: string, label: string) {
  if (set.size && !set.has(value.toUpperCase()) && !set.has(value.split(".").slice(-1)[0])) throw new Error(`${label} is outside the configured allowlist.`);
}
function cursor<T>(items: T[], size = 100): SnowflakeCursor<T> {
  let index = 0;
  return new CursorImpl(() => { const page = items.slice(index, index += size); return page.length ? page : null; });
}
@validateRpc() class CursorImpl<T> extends RpcTarget implements SnowflakeCursor<T> { constructor(private readonly nextPage: () => T[] | null) { super(); } next(): Promise<T[] | null> { return Promise.resolve(this.nextPage()); } }

class SnowflakeApi {
  constructor(private readonly env: Env) {}
  private async request(body: Record<string, unknown>) {
    const base = (this.env.SNOWFLAKE_BASE_URL ?? `https://${this.env.SNOWFLAKE_ACCOUNT}.snowflakecomputing.com`).replace(/\/$/, "");
    const response = await fetch(`${base}/api/v2/statements`, { method: "POST", headers: { authorization: `Bearer ${this.env.SNOWFLAKE_TOKEN}`, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Snowflake request failed (${response.status}).`);
    const data = await response.json() as any;
    const result = Array.isArray(data.data) ? data.data : [];
    const meta = Array.isArray(data.resultSetMetaData?.rowType) ? data.resultSetMetaData.rowType : [];
    return { queryId: String(data.statementHandle ?? data.queryId ?? "unknown"), columns: meta.map((x: any) => ({ name: String(x.name ?? ""), type: String(x.type ?? "") })), rows: result };
  }
  async sql(sql: string, options: ReadOnlySqlOptions, maxRows: number, maxBytes: number): Promise<ReadOnlySqlResult> {
    const text = sql.trim().replace(/;+$/, "");
    if (text.length > MAX_SQL || !/^SELECT\b/i.test(text) || /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|COPY|CALL|USE|GRANT|REVOKE|PUT|GET)\b/i.test(text)) throw new Error("Only bounded SELECT statements are permitted.");
    const db = identifier(options.database, "database"), schema = identifier(options.schema, "schema");
    const result = await this.request({ statement: text, timeout: boundedInt(options.timeoutSeconds, 30, 120), database: db, schema, warehouse: options.warehouse });
    const rows = result.rows.slice(0, Math.min(maxRows, boundedInt(options.maxRows, maxRows, maxRows)));
    const encoded = JSON.stringify(rows); const clipped = encoded.length > Math.min(maxBytes, boundedInt(options.maxBytes, maxBytes, maxBytes));
    return { queryId: result.queryId, columns: result.columns, rows: clipped ? rows.slice(0, Math.max(0, rows.length - 1)) : rows, rowCount: rows.length, truncated: clipped || rows.length < result.rows.length, elapsedMs: 0 };
  }
  async metadata(sql: string) { return this.request({ statement: sql, timeout: 30 }); }
}

type Props = { account?: string };
@validateRpc() export class GatekeeperVendor extends WorkerEntrypoint<Env> {
  async describe(): Promise<VendorDescription> { return { displayName: "Snowflake", url: "https://www.snowflake.com", logo: ICON, color: "#29b5e8", tagline: "Governed data and Cortex access", description: "Scoped Snowflake metadata, bounded read-only SQL, Cortex, and approval-gated data actions.", providesAuth: false, autoProvisionsAccount: true }; }
  @skipRpcValidation() async createAccount(): Promise<Fetcher<GatekeeperUser>> { return (this.ctx.exports as any).SnowflakeAccount({}); }
  async connectAccount(_cb: Fetcher<GatekeeperConnectCallback>, _o?: GatekeeperConnectOptions): Promise<{ url: string }> { throw new Error("Snowflake uses a deployment-configured OAuth/token connection; interactive connect is not enabled yet."); }
  async getSupportedResources(): Promise<SupportedResource[]> { return [RESOURCE]; }
  async getTypeScriptTypes(): Promise<string> { return TYPES_CODE; }
}
@validateRpc() export class SnowflakeAccount extends WorkerEntrypoint<Env> implements GatekeeperUser {
  async describe(): Promise<AccountDescription> { return { displayName: this.env.SNOWFLAKE_ACCOUNT, avatar: ICON, singleton: { tsType: "SnowflakeSession" } }; }
  async getSupportedResources() { return [RESOURCE]; }
  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<SnowflakeSession>>> { return (this.ctx.exports as any).SnowflakeGatekeeper({ props: { account: this.env.SNOWFLAKE_ACCOUNT } }); }
  async getGatekeeperClassFor(url: string) { const parsed = new URL(url); if (parsed.protocol !== "snowflake:") throw new Error("Snowflake resource must use snowflake://."); return { class: (this.ctx.exports as any).SnowflakeGatekeeper({ props: { account: parsed.hostname } }), resource: RESOURCE }; }
  async startResourceConfigurator(): Promise<any> { throw new Error("Snowflake resource configurator is not enabled yet; use an explicitly configured account binding."); }
  async revoke() {} async reconnect(): Promise<{ url: string }> { throw new Error("Reconnect is managed by the deployment credential."); }
  async commitReconnect(_stageId: string) {} async ensureResources() { return {}; } async getAuthenticatedEmail() { return null; }
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> { return (this.ctx.exports as any).SnowflakeVerifier({}); }
}
@validateRpc() export class SnowflakeVerifier extends WorkerEntrypoint<Env> implements GatekeeperUserVerifier { verify(): void {} }
type SnowflakeActionState = "staged" | "pending" | "approved" | "rejected";
type SnowflakeWriteAction = { proposalId: string; operation: "insert" | "update" | "merge"; target: string; sql: string };
type StoredSnowflakeAction = SnowflakeWriteAction & {
  actionId: number;
  state: SnowflakeActionState;
  submittedAt: number;
  appliedAt?: number;
  rejectedAt?: number;
};

@validateRpc() export class SnowflakeGatekeeper extends DurableObject<Env, Props> implements Gatekeeper<SnowflakeSession> {
  async describe(): Promise<ResourceDescription> { return { url: `snowflake://${this.ctx.props?.account ?? this.env.SNOWFLAKE_ACCOUNT}`, title: "Snowflake capability", snippet: "Bounded metadata, read-only SQL, Cortex, and approved custom tools.", suggestedBindingName: "SNOWFLAKE", tsType: "SnowflakeSession" }; }
  async getTypeScriptTypes() { return TYPES_CODE; } async getAutoApprovableActions(): Promise<[]> { return []; }
  async startSession(q: RpcStub<ApprovalQueue>): Promise<SnowflakeSession> { return new SessionImpl(q.dup(), this.env, this); }
  async addObserver() { throw new Error("Snowflake bindings require observer ACL verification before sharing."); }
  async removeObserver() {}

  async applyAction(actionId: number): Promise<void> {
    const record = await this.#requireActionRecord(actionId);
    // Idempotent on overseer re-delivery: a crash after the remote write but before the overseer
    // recorded completion replays applyAction. The durable record is the only authority on
    // whether the DML already ran, so an already-approved action reports success rather than
    // throwing (which would strand the action as forever un-appliable).
    if (record.state === "approved") return;
    if (record.state !== "pending" && record.state !== "staged") throw new Error(`Snowflake action ${actionId} is no longer pending.`);
    throw new Error("Snowflake action executor is not enabled.");
  }

  async rejectAction(actionId: number): Promise<void> {
    const record = await this.#requireActionRecord(actionId);
    if (record.state !== "pending" && record.state !== "staged") throw new Error(`Snowflake action ${actionId} is no longer pending.`);
    record.state = "rejected";
    record.rejectedAt = Date.now();
    // Retire rather than delete: the record is the durable evidence that the proposal was
    // rejected, and getWriteProposal() must keep answering for it.
    await this.ctx.storage.kv.delete(`action:${actionId}`);
    await this.ctx.storage.kv.put(`retiredAction:${actionId}`, record);
  }

  async revertAction() { throw new Error("Snowflake actions are not reversible automatically."); }

  async #nextActionId(): Promise<number> {
    const key = "counter:action";
    const value = ((await this.ctx.storage.kv.get<number>(key)) ?? 0) + 1;
    await this.ctx.storage.kv.put(key, value);
    return value;
  }

  async #stageAction(action: SnowflakeWriteAction): Promise<number> {
    const id = await this.#nextActionId();
    await this.ctx.storage.kv.put(`action:${id}`, { ...action, actionId: id, state: "staged", submittedAt: Date.now() } satisfies StoredSnowflakeAction);
    return id;
  }

  async #markActionPending(actionId: number): Promise<void> {
    const record = await this.#requireActionRecord(actionId);
    record.state = "pending";
    await this.ctx.storage.kv.put(`action:${actionId}`, record);
  }

  async #getActionRecord(actionId: number): Promise<StoredSnowflakeAction | undefined> {
    return (await this.ctx.storage.kv.get<StoredSnowflakeAction>(`action:${actionId}`))
      ?? (await this.ctx.storage.kv.get<StoredSnowflakeAction>(`retiredAction:${actionId}`));
  }

  async #requireActionRecord(actionId: number): Promise<StoredSnowflakeAction> {
    const record = await this.#getActionRecord(actionId);
    if (!record) throw new Error(`No queued Snowflake action exists with id ${actionId}.`);
    return record;
  }

  async queueAction(id: number, action: unknown) { await this.ctx.storage.kv.put(`action:${id}`, action); }

  async stageWrite(action: SnowflakeWriteAction): Promise<number> {
    return this.#stageAction(action);
  }

  async markWritePending(actionId: number): Promise<void> {
    await this.#markActionPending(actionId);
  }

  async discardStagedWrite(actionId: number): Promise<void> {
    const record = await this.#getActionRecord(actionId);
    if (record?.state === "staged") await this.ctx.storage.kv.delete(`action:${actionId}`);
  }

  async findWriteByProposalId(proposalId: string): Promise<SnowflakeWriteProposal | null> {
    const live: StoredSnowflakeAction[] = [];
    for (const [, record] of await this.ctx.storage.kv.list<StoredSnowflakeAction>({ prefix: "action:" })) live.push(record);
    const retired: StoredSnowflakeAction[] = [];
    for (const [, record] of await this.ctx.storage.kv.list<StoredSnowflakeAction>({ prefix: "retiredAction:" })) retired.push(record);
    for (const record of [...live, ...retired]) {
      if (record?.proposalId !== proposalId) continue;
      return { proposalId, actionId: record.actionId, operation: record.operation, target: record.target, sql: record.sql, simulated: true };
    }
    return null;
  }
}
@validateRpc() class SessionImpl extends RpcTarget implements SnowflakeSession {
  constructor(private readonly queue: RpcStub<ApprovalQueue>, private readonly env: Env, private readonly gatekeeper: SnowflakeGatekeeper) { super(); }
  private policy() { return config(this.env); } private api() { return new SnowflakeApi(this.env); }
  async getAccount(): Promise<SnowflakeAccountInfo> { return { accountIdentifier: this.env.SNOWFLAKE_ACCOUNT, role: this.env.SNOWFLAKE_ROLE, warehouse: this.env.SNOWFLAKE_WAREHOUSE }; }
  async listDatabases() { const p = this.policy(); const names = [...p.databases].map(name => ({ name })); await this.queue.authorizeObservation({ title: "Read Snowflake databases", description: "Read the configured Snowflake database catalog." }); return cursor<DatabaseSummary>(names); }
  async listSchemas(database: string) { const p = this.policy(); const d = identifier(database, "database"); allowed(p.databases, d, "Database"); const x = await this.api().metadata(`SHOW SCHEMAS IN DATABASE ${d}`); const rows = (x.rows ?? []).slice(0, 1000).map((r: any[]) => ({ database: d, name: String(r[1] ?? r[0] ?? "") })); await this.queue.authorizeObservation({ title: "Read Snowflake schemas", description: `Read schemas in ${d}.` }); return cursor<SchemaSummary>(rows); }
  async listTables(database: string, schema: string) { const p = this.policy(); const q = qualified(database, schema); allowed(p.databases, database, "Database"); allowed(p.schemas, q, "Schema"); const x = await this.api().metadata(`SHOW TABLES IN SCHEMA ${q}`); const rows = (x.rows ?? []).slice(0, 1000).map((r: any[]) => ({ database: identifier(database, "database"), schema: identifier(schema, "schema"), name: String(r[1] ?? r[0] ?? ""), kind: "table" as const })); await this.queue.authorizeObservation({ title: "Read Snowflake tables", description: `Read tables in ${q}.` }); return cursor<TableSummary>(rows); }
  async describeTable(database: string, schema: string, table: string): Promise<TableDescription> { const p = this.policy(); const q = qualified(database, schema, table); allowed(p.tables, q, "Table"); const x = await this.api().metadata(`DESCRIBE TABLE ${q}`); const columns: ColumnDescription[] = (x.rows ?? []).slice(0, 1000).map((r: any[]) => ({ name: String(r[0] ?? ""), dataType: String(r[1] ?? ""), nullable: String(r[3] ?? "YES").toUpperCase() === "YES" })); await this.queue.authorizeObservation({ title: "Read Snowflake table description", description: `Read the schema for ${q}.` }); return { database: identifier(database, "database"), schema: identifier(schema, "schema"), name: identifier(table, "table"), kind: "table", columns }; }
  async runReadOnlySql(sql: string, options: ReadOnlySqlOptions): Promise<ReadOnlySqlResult> { const p = this.policy(); const q = qualified(options.database, options.schema); allowed(p.schemas, q, "Schema"); const out = await this.api().sql(sql, options, p.maxRows, p.maxBytes); await this.queue.authorizeObservation({ title: "Read Snowflake query result", description: `Read a bounded SELECT in ${q}.` }); return out; }
  async cortexAnalyst(_r: CortexAnalystRequest): Promise<CortexAnalystResult> { throw new Error("Cortex Analyst requires an explicitly configured Snowflake semantic view endpoint."); }
  async cortexSearch(_r: CortexSearchRequest): Promise<CortexSearchResult> { throw new Error("Cortex Search requires an explicitly configured service endpoint."); }
  async runCortexAgent(_r: CortexAgentRequest): Promise<CortexAgentResult> { throw new Error("Cortex Agent is disabled until recursion and target allowlists are configured."); }
  async listCustomTools() { await this.queue.authorizeObservation({ title: "Read Snowflake custom tools", description: "Read the configured custom-tool allowlist." }); return cursor<CustomToolSummary>([]); }
  async runCustomTool(_r: CustomToolRequest): Promise<CustomToolResult> { throw new Error("Custom Snowflake tools are disabled until individually allowlisted and schema-validated."); }
  async proposeWrite(operation: "insert" | "update" | "merge", target: string, sql: string): Promise<SnowflakeWriteProposal> {
    const p = this.policy(); const segments = target.split(".");
    if (segments.length !== 3) throw new Error("Write target must be DATABASE.SCHEMA.TABLE.");
    const table = qualified(segments[0], segments[1], segments[2]); allowed(p.tables, table, "Table");
    if (!new RegExp(`^${operation}\\b`, "i").test(sql.trim()) || /\b(DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE|CALL|DELETE)\b/i.test(sql)) throw new Error("Only bounded INSERT, UPDATE, or MERGE proposals are permitted.");
    if (sql.length > MAX_SQL) throw new Error("SQL proposal exceeds the size limit.");
    const proposalId = crypto.randomUUID();
    const actionId = await this.gatekeeper.stageWrite({ proposalId, operation, target: table, sql });
    try {
      await this.queue.submitAction(actionId, {
        title: `Snowflake ${operation.toUpperCase()} on ${table}`,
        description: [
          `Propose a **${operation.toUpperCase()}** against Snowflake table \`${table}\`.`,
          "",
          "The statement below has not been executed. It will run only if this action is approved.",
          "",
          "```sql",
          sql,
          "```",
        ].join("\n"),
        implementsRevert: false,
      });
    } catch (error) {
      // submitAction rejected the proposal (policy or transport): drop the staged record so no
      // orphaned action id lingers, then propagate.
      await this.gatekeeper.discardStagedWrite(actionId);
      throw error;
    }
    await this.gatekeeper.markWritePending(actionId);
    return { proposalId, actionId, operation, target: table, sql, simulated: true };
  }
  async getWriteProposal(proposalId: string): Promise<SnowflakeWriteProposal | null> {
    return this.gatekeeper.findWriteByProposalId(proposalId);
  }
  [Symbol.dispose]() { this.queue[Symbol.dispose]?.(); }
}
export default { async fetch() { return new Response("Snowflake Gatekeeper worker is running.", { headers: { "content-type": "text/plain" } }); } };

