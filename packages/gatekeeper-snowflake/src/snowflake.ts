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
  ReadOnlySqlPageLimits, ReadOnlySqlPages,
  CortexAnalystRequest, CortexAnalystResult, CortexSearchRequest, CortexSearchResult, SearchResult,
  CortexAgentRequest, CortexAgentResult, CustomToolSummary, CustomToolRequest, CustomToolResult,
  SnowflakeWriteProposal,
  SnowflakeSession,
} from "./types.js";
import TYPES_CODE from "./types-code.js";
import { Stage, GatedActions, proposeAction, type StageRecord } from "@gadgets/stage";
import { LivePageSource } from "@gadgets/cursor";
import { boundedSelect, partitionPager, type PartitionMeta, type ReadOnlySqlPage } from "./sql-pages.js";
import {
  allowed, boundedInt, boundedText, identifier, qualified, snowflakePolicy, validateWriteProposal,
  writesEnabled, MAX_QUESTION, MAX_SQL,
} from "./policy.js";

const RESOURCE: SupportedResource = {
  urlPattern: "snowflake://account/*",
  title: "Snowflake account capability",
  description: "Scoped Snowflake metadata, bounded read-only SQL, Cortex Analyst/Search, and approval-gated data actions.",
  grantable: true,
};
const ICON = { url: "https://www.snowflake.com/wp-content/uploads/2022/03/cropped-snowflake.png" };
function cell(row: unknown[], columns: { name: string }[], key: string): unknown {
  const index = columns.findIndex(c => c.name.toLowerCase() === key);
  return index >= 0 ? row[index] : undefined;
}
function cursor<T>(items: T[], size = 100): SnowflakeCursor<T> {
  let index = 0;
  return new CursorImpl(() => { const page = items.slice(index, index += size); return page.length ? page : null; });
}
@validateRpc() class CursorImpl<T> extends RpcTarget implements SnowflakeCursor<T> { constructor(private readonly nextPage: () => T[] | null) { super(); } next(): Promise<T[] | null> { return Promise.resolve(this.nextPage()); } }

/**
 * The RPC surface of the partitioned-result capability. Walk mechanics — page budget, idempotent
 * exhaustion, in-flight guard — are delegated to @gadgets/cursor; the minting session binds the
 * capability to the validated statement, its budget, and the approval queue, so authority and
 * resource identity survive the hand-off to the agent.
 */
@validateRpc()
class SqlPagesCursor extends RpcTarget implements ReadOnlySqlPages {
  constructor(
    private readonly source: LivePageSource<ReadOnlySqlPage>,
    private readonly queryId: string,
    private readonly columns: { name: string; type: string }[],
    private readonly totalRows: number | undefined,
    private readonly limits: ReadOnlySqlPageLimits,
  ) { super(); }
  next(): Promise<ReadOnlySqlPage | null> { return this.source.next().then((pages) => pages?.[0] ?? null); }
  getQueryId(): Promise<string> { return Promise.resolve(this.queryId); }
  getColumns(): Promise<{ name: string; type: string }[]> { return Promise.resolve(this.columns); }
  getTotalRows(): Promise<number | null> { return Promise.resolve(this.totalRows ?? null); }
  getLimits(): Promise<ReadOnlySqlPageLimits> { return Promise.resolve(this.limits); }
}

class SnowflakeApi {
  constructor(private readonly env: Env) {}
  #base(): string {
    return (this.env.SNOWFLAKE_BASE_URL ?? `https://${this.env.SNOWFLAKE_ACCOUNT}.snowflakecomputing.com`).replace(/\/$/, "");
  }
  async #post(path: string, body: Record<string, unknown>, label: string): Promise<any> {
    const response = await fetch(`${this.#base()}${path}`, { method: "POST", headers: { authorization: `Bearer ${this.env.SNOWFLAKE_TOKEN}`, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`${label} failed (${response.status}).`);
    return response.json();
  }
  // The configured role is sent explicitly on every statement: getAccount() advertises it as the
  // capability's active role, so it must actually govern what runs rather than falling back to
  // the credential's default role.
  async request(body: Record<string, unknown>) {
    const data = await this.#post("/api/v2/statements", { role: this.env.SNOWFLAKE_ROLE, ...body }, "Snowflake request");
    return this.#resultSet(data);
  }

  /** Normalizes one ResultSet response, including the verified partition metadata. */
  #resultSet(data: any) {
    const result = Array.isArray(data.data) ? data.data : [];
    const meta = Array.isArray(data.resultSetMetaData?.rowType) ? data.resultSetMetaData.rowType : [];
    const partitionInfo = Array.isArray(data.resultSetMetaData?.partitionInfo) ? data.resultSetMetaData.partitionInfo : [];
    return {
      queryId: String(data.statementHandle ?? data.queryId ?? "unknown"),
      columns: meta.map((x: any) => ({ name: String(x.name ?? ""), type: String(x.type ?? "") })),
      rows: result,
      // Verified contract: numRows is the total the statement produced; partitionInfo describes
      // every partition, the first being the one returned inline.
      totalRows: typeof data.resultSetMetaData?.numRows === "number" ? data.resultSetMetaData.numRows : undefined,
      partitions: partitionInfo.length
        ? partitionInfo.map((x: any) => ({ rowCount: Number(x?.rowCount ?? 0), ...(typeof x?.uncompressedSize === "number" ? { uncompressedSize: x.uncompressedSize } : {}) }))
        : undefined,
      statementHandle: typeof data.statementHandle === "string" ? data.statementHandle : undefined,
    };
  }

  /** Retrieves one promised partition: GET /api/v2/statements/{handle}?partition={n}. */
  async partition(handle: string, partition: number): Promise<{ rows: unknown[][] }> {
    if (!/^[A-Za-z0-9-]+$/.test(handle)) throw new Error("Invalid Snowflake statement handle.");
    if (!Number.isInteger(partition) || partition < 1) throw new Error("Invalid partition number.");
    const response = await fetch(`${this.#base()}/api/v2/statements/${encodeURIComponent(handle)}?partition=${partition}`, {
      headers: { authorization: `Bearer ${this.env.SNOWFLAKE_TOKEN}`, accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Snowflake partition fetch failed (${response.status}).`);
    const data: any = await response.json();
    return { rows: Array.isArray(data.data) ? data.data : [] };
  }

  /** Validates the statement and executes it, returning the first (possibly only) partition. */
  async execute(sql: string, options: ReadOnlySqlOptions) {
    const text = boundedSelect(sql);
    const db = identifier(options.database, "database"), schema = identifier(options.schema, "schema");
    return this.request({ statement: text, timeout: boundedInt(options.timeoutSeconds, 30, 120), database: db, schema, warehouse: options.warehouse });
  }

  async sql(sql: string, options: ReadOnlySqlOptions, maxRows: number, maxBytes: number): Promise<ReadOnlySqlResult> {
    const startedAt = Date.now();
    const result = await this.execute(sql, options);
    const rowLimit = Math.min(maxRows, boundedInt(options.maxRows, maxRows, maxRows));
    const byteLimit = Math.min(maxBytes, boundedInt(options.maxBytes, maxBytes, maxBytes));
    let rows = result.rows.slice(0, rowLimit);
    // Drop whole rows until the encoded payload fits the byte budget: a partially clipped row
    // would not be valid JSON for the consumer.
    while (rows.length > 0 && JSON.stringify(rows).length > byteLimit) rows = rows.slice(0, -1);
    return { queryId: result.queryId, columns: result.columns, rows, rowCount: rows.length, truncated: rows.length < result.rows.length, elapsedMs: Date.now() - startedAt };
  }
  async metadata(sql: string) { return this.request({ statement: sql, timeout: 30 }); }
  async analyst(body: Record<string, unknown>) { return this.#post("/api/v2/cortex/analyst/message", body, "Cortex Analyst request"); }
  async search(database: string, schema: string, service: string, body: Record<string, unknown>) {
    return this.#post(`/api/v2/databases/${database}/schemas/${schema}/cortex-search-services/${service}:query`, body, "Cortex Search request");
  }
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
type SnowflakeWriteAction = { proposalId: string; operation: "insert" | "update" | "merge"; target: string; sql: string };
type StoredSnowflakeAction = StageRecord<SnowflakeWriteAction>;

@validateRpc() export class SnowflakeGatekeeper extends DurableObject<Env, Props> implements Gatekeeper<SnowflakeSession> {
  readonly #stage = new Stage<SnowflakeWriteAction>({ kv: this.ctx.storage.kv, label: "Snowflake" });
  readonly #gated = new GatedActions(this.#stage, "Snowflake");

  async describe(): Promise<ResourceDescription> { return { url: `snowflake://${this.ctx.props?.account ?? this.env.SNOWFLAKE_ACCOUNT}`, title: "Snowflake capability", snippet: "Bounded metadata, read-only SQL, Cortex Analyst/Search, and approval-gated data actions.", suggestedBindingName: "SNOWFLAKE", tsType: "SnowflakeSession" }; }
  async getTypeScriptTypes() { return TYPES_CODE; } async getAutoApprovableActions(): Promise<[]> { return []; }
  async startSession(q: RpcStub<ApprovalQueue>): Promise<SnowflakeSession> { return new SessionImpl(q.dup(), this.env, this); }
  async addObserver() { throw new Error("Snowflake bindings require observer ACL verification before sharing."); }
  async removeObserver() {}

  async applyAction(actionId: number): Promise<void> {
    await this.#gated.apply(actionId, {
      writesEnabled: writesEnabled(this.env),
      disabledMessage: "Snowflake action executor is not enabled.",
      execute: (record) => this.#execute(record),
    });
  }

  // The executor runs only behind an explicit operator gate (SNOWFLAKE_ENABLE_WRITES) and after a
  // human approval; the durable Stage record is the completion evidence. The stored payload is
  // re-validated against the same policy as a fresh proposal before any remote call.
  async #execute(record: StoredSnowflakeAction): Promise<void> {
    const policy = snowflakePolicy(this.env);
    const { database, schema } = validateWriteProposal(policy, record.operation, record.target, record.sql);
    await new SnowflakeApi(this.env).request({
      statement: record.sql,
      timeout: 30,
      database,
      schema,
      ...(this.env.SNOWFLAKE_WAREHOUSE ? { warehouse: this.env.SNOWFLAKE_WAREHOUSE } : {}),
    });
  }

  async rejectAction(actionId: number): Promise<void> {
    // Stage.reject itself gates on state and retires rather than deletes: the record is the
    // durable evidence that the proposal was rejected, and getWriteProposal() must keep
    // answering for it.
    await this.#stage.reject(actionId);
  }

  async revertAction() { throw new Error("Snowflake actions are not reversible automatically."); }

  async stageAction(action: SnowflakeWriteAction): Promise<number> {
    return this.#stage.stage(action);
  }

  async markActionPending(actionId: number): Promise<void> {
    await this.#stage.markPending(actionId);
  }

  async discardStagedAction(actionId: number): Promise<void> {
    await this.#stage.discardStaged(actionId);
  }

  async findActionByProposalId(proposalId: string): Promise<SnowflakeWriteProposal | null> {
    const record = await this.#stage.findByProposalId(proposalId);
    if (!record) return null;
    // Honest state: once the executor has applied the DML it is no longer simulated.
    return { proposalId, actionId: record.actionId, operation: record.operation, target: record.target, sql: record.sql, simulated: record.state !== "approved" };
  }
}
@validateRpc() class SessionImpl extends RpcTarget implements SnowflakeSession {
  constructor(private readonly queue: RpcStub<ApprovalQueue>, private readonly env: Env, private readonly gatekeeper: SnowflakeGatekeeper) { super(); }
  private policy() { return snowflakePolicy(this.env); } private api() { return new SnowflakeApi(this.env); }
  async getAccount(): Promise<SnowflakeAccountInfo> { return { accountIdentifier: this.env.SNOWFLAKE_ACCOUNT, role: this.env.SNOWFLAKE_ROLE, warehouse: this.env.SNOWFLAKE_WAREHOUSE }; }
  async listDatabases() {
    const p = this.policy();
    const x = await this.api().metadata("SHOW DATABASES");
    const live = (x.rows ?? []).slice(0, 1000).map((r: unknown[]) => {
      const name = String(cell(r, x.columns, "name") ?? "");
      const raw = cell(r, x.columns, "comment");
      const comment = raw === undefined || raw === null || raw === "" ? undefined : String(raw);
      return { name, ...(comment ? { comment } : {}) };
    }).filter((d: { name: string }) => d.name);
    // The configured allowlist narrows the live catalog; with no allowlist the full catalog is
    // returned under the same 1000-entry page cap.
    const names = p.databases.size ? live.filter((d: { name: string }) => p.databases.has(d.name.toUpperCase())) : live;
    await this.queue.authorizeObservation({ title: "Read Snowflake databases", description: "Read the Snowflake database catalog." });
    return cursor<DatabaseSummary>(names);
  }
  async listSchemas(database: string) { const p = this.policy(); const d = identifier(database, "database"); allowed(p.databases, d, "Database"); const x = await this.api().metadata(`SHOW SCHEMAS IN DATABASE ${d}`); const rows = (x.rows ?? []).slice(0, 1000).map((r: any[]) => ({ database: d, name: String(r[1] ?? r[0] ?? "") })); await this.queue.authorizeObservation({ title: "Read Snowflake schemas", description: `Read schemas in ${d}.` }); return cursor<SchemaSummary>(rows); }
  async listTables(database: string, schema: string) { const p = this.policy(); const q = qualified(database, schema); allowed(p.databases, database, "Database"); allowed(p.schemas, q, "Schema"); const x = await this.api().metadata(`SHOW TABLES IN SCHEMA ${q}`); const rows = (x.rows ?? []).slice(0, 1000).map((r: any[]) => ({ database: identifier(database, "database"), schema: identifier(schema, "schema"), name: String(r[1] ?? r[0] ?? ""), kind: "table" as const })); await this.queue.authorizeObservation({ title: "Read Snowflake tables", description: `Read tables in ${q}.` }); return cursor<TableSummary>(rows); }
  async describeTable(database: string, schema: string, table: string): Promise<TableDescription> { const p = this.policy(); const q = qualified(database, schema, table); allowed(p.tables, q, "Table"); const x = await this.api().metadata(`DESCRIBE TABLE ${q}`); const columns: ColumnDescription[] = (x.rows ?? []).slice(0, 1000).map((r: any[]) => ({ name: String(r[0] ?? ""), dataType: String(r[1] ?? ""), nullable: String(r[3] ?? "YES").toUpperCase() === "YES" })); await this.queue.authorizeObservation({ title: "Read Snowflake table description", description: `Read the schema for ${q}.` }); return { database: identifier(database, "database"), schema: identifier(schema, "schema"), name: identifier(table, "table"), kind: "table", columns }; }
  async runReadOnlySql(sql: string, options: ReadOnlySqlOptions): Promise<ReadOnlySqlResult> { const p = this.policy(); const q = qualified(options.database, options.schema); allowed(p.databases, options.database, "Database"); allowed(p.schemas, q, "Schema"); const out = await this.api().sql(sql, options, p.maxRows, p.maxBytes); await this.queue.authorizeObservation({ title: "Read Snowflake query result", description: `Read a bounded SELECT in ${q}.` }); return out; }

  /**
   * The paging form of the read-only query: the same validated, allowlisted bounded SELECT, with
   * the same cumulative maxRows/maxBytes budgets — filled across the partitions Snowflake's
   * verified metadata promises instead of stopping at the first one. Returns a live cursor
   * capability; every fetched page re-authorizes its observation through this session's queue.
   */
  async runReadOnlySqlPages(sql: string, options: ReadOnlySqlOptions): Promise<ReadOnlySqlPages> {
    const p = this.policy();
    const q = qualified(options.database, options.schema);
    allowed(p.databases, options.database, "Database");
    allowed(p.schemas, q, "Schema");
    const api = this.api();
    const first = await api.execute(sql, options);
    await this.queue.authorizeObservation({ title: "Read Snowflake query result pages", description: `Read a bounded SELECT in ${q}.` });
    const pager = partitionPager(
      { rows: first.rows, totalRows: first.totalRows, partitions: first.partitions },
      { rowsPerPage: p.resultRowsPerPage, maxRows: p.maxRows, maxBytes: p.maxBytes },
      (partition) => api.partition(first.statementHandle ?? first.queryId, partition),
    );
    const source = new LivePageSource<ReadOnlySqlPage>({
      fetchPage: pager.fetchPage,
      maxPages: p.maxResultPages,
      label: "Snowflake result",
    });
    return new SqlPagesCursor(
      source,
      first.queryId,
      first.columns,
      pager.totalRows,
      { rowsTotal: p.maxRows, bytesTotal: p.maxBytes, rowsPerPage: p.resultRowsPerPage, maxPages: p.maxResultPages },
    );
  }
  async cortexAnalyst(r: CortexAnalystRequest): Promise<CortexAnalystResult> {
    const p = this.policy();
    // Fail closed: Analyst runs only against operator-allowlisted semantic views.
    if (!p.semanticViews.size) throw new Error("Cortex Analyst requires an explicitly configured semantic view allowlist (SNOWFLAKE_CORTEX_SEMANTIC_VIEWS).");
    const segments = r.semanticView.split(".");
    if (segments.length !== 3) throw new Error("Semantic view must be DATABASE.SCHEMA.VIEW.");
    const view = qualified(segments[0], segments[1], segments[2]);
    allowed(p.semanticViews, view, "Semantic view");
    boundedText(r.question, MAX_QUESTION, "Question");
    await this.queue.authorizeObservation({ title: "Ask Cortex Analyst", description: `Ask Cortex Analyst a question using semantic view \`${view}\`.` });
    const data = await this.api().analyst({
      messages: [{ role: "user", content: [{ type: "text", text: r.question }] }],
      semantic_view: view,
    });
    const content = Array.isArray(data.message?.content) ? data.message.content : [];
    let answer = "";
    let generatedSql: string | undefined;
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string") answer += (answer ? "\n\n" : "") + block.text;
      if (block?.type === "sql" && typeof block.statement === "string") generatedSql = block.statement;
    }
    if (!answer && !generatedSql) throw new Error("Cortex Analyst returned no usable answer.");
    // Run the generated SQL only when its schema is allowlisted and it passes the same bounded
    // SELECT guard as runReadOnlySql; otherwise return the statement unexecuted.
    let rows: unknown[][] | undefined;
    let truncated = false;
    if (generatedSql) {
      const context = `${identifier(segments[0], "database")}.${identifier(segments[1], "schema")}`;
      if (!p.schemas.size || p.schemas.has(context)) {
        try {
          const q = await this.api().sql(generatedSql, { database: segments[0], schema: segments[1], maxRows: r.maxRows }, p.maxRows, p.maxBytes);
          rows = q.rows;
          truncated = q.truncated;
        } catch {
          // Not a bounded SELECT (or the query failed): the statement is returned unexecuted.
        }
      }
    }
    return { answer: answer || generatedSql!, generatedSql, rows, citations: [], truncated };
  }
  async cortexSearch(r: CortexSearchRequest): Promise<CortexSearchResult> {
    const p = this.policy();
    // Fail closed: Search runs only against operator-allowlisted services.
    if (!p.searchServices.size) throw new Error("Cortex Search requires an explicitly configured service allowlist (SNOWFLAKE_CORTEX_SEARCH_SERVICES).");
    const segments = r.service.split(".");
    if (segments.length !== 3) throw new Error("Search service must be DATABASE.SCHEMA.SERVICE.");
    const service = qualified(segments[0], segments[1], segments[2]);
    allowed(p.searchServices, service, "Search service");
    boundedText(r.query, MAX_QUESTION, "Search query");
    await this.queue.authorizeObservation({ title: "Query Cortex Search", description: `Query the Cortex Search service \`${service}\`.` });
    // No `columns` parameter: the service returns its own search column, which keeps rows small.
    const data = await this.api().search(segments[0].toUpperCase(), segments[1].toUpperCase(), segments[2].toUpperCase(), { query: r.query, limit: boundedInt(r.maxResults, 10, 100) });
    const raw = Array.isArray(data.results) ? data.results : [];
    const results: SearchResult[] = raw.slice(0, 100).map((row: Record<string, unknown>) => {
      const strings = Object.values(row ?? {}).filter((v): v is string => typeof v === "string");
      const snippet = strings.sort((a, b) => b.length - a.length)[0] ?? JSON.stringify(row ?? {});
      return { title: service, snippet: snippet.slice(0, 2_000) };
    });
    return { results, truncated: raw.length > results.length };
  }
  async runCortexAgent(_r: CortexAgentRequest): Promise<CortexAgentResult> { throw new Error("Cortex Agent is disabled until recursion and target allowlists are configured."); }
  async listCustomTools() { await this.queue.authorizeObservation({ title: "Read Snowflake custom tools", description: "Read the configured custom-tool allowlist." }); return cursor<CustomToolSummary>([]); }
  async runCustomTool(_r: CustomToolRequest): Promise<CustomToolResult> { throw new Error("Custom Snowflake tools are disabled until individually allowlisted and schema-validated."); }
  async proposeWrite(operation: "insert" | "update" | "merge", target: string, sql: string): Promise<SnowflakeWriteProposal> {
    const p = this.policy();
    const table = validateWriteProposal(p, operation, target, sql).table;
    const payload: SnowflakeWriteAction = { proposalId: crypto.randomUUID(), operation, target: table, sql };
    const { actionId } = await proposeAction(this.gatekeeper, this.queue, payload, {
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
      // Snowflake writes are not simulated: reads cannot reflect pending DML, so the agent must
      // not keep working against pre-write state.
      awaitDecision: true,
    });
    return { ...payload, actionId, simulated: true };
  }
  async getWriteProposal(proposalId: string): Promise<SnowflakeWriteProposal | null> {
    return this.gatekeeper.findActionByProposalId(proposalId);
  }
  [Symbol.dispose]() { this.queue[Symbol.dispose]?.(); }
}
export default { async fetch() { return new Response("Snowflake Gatekeeper worker is running.", { headers: { "content-type": "text/plain" } }); } };

