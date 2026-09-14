// The agent-facing API, hand-synced with types.d.ts (see __tests__/actions.test.ts). Kept as a
// string literal rather than a ?raw import: capnweb-validate treats .d.ts as a TypeScript file and
// does not copy it into the wrangler bundle output, so a raw import cannot resolve at deploy time.
const TYPES_CODE = `/**
 * Agent-facing API for the Snowflake Gatekeeper (moderate capability tier).
 *
 * This is a capability-scoped API, not a Snowflake driver. The bound resource URL selects
 * one account/database/schema or named Cortex resource. Credentials, arbitrary endpoints,
 * and unrestricted SQL are never exposed to the Gadget.
 */

export interface SnowflakeAccount {
  /** Stable Snowflake account locator/name, never an access token. */
  accountIdentifier: string;
  /** Active role used for this capability. */
  role: string;
  /** Default warehouse, when configured. */
  warehouse?: string;
}

export interface DatabaseSummary {
  name: string;
  comment?: string;
}

export interface SchemaSummary {
  database: string;
  name: string;
  comment?: string;
}

export interface TableSummary {
  database: string;
  schema: string;
  name: string;
  kind: "table" | "view" | "semantic_view";
  comment?: string;
}

export interface ColumnDescription {
  name: string;
  dataType: string;
  nullable: boolean;
  comment?: string;
}

export interface TableDescription extends TableSummary {
  columns: ColumnDescription[];
}

/** A bounded, opaque continuation token. Do not construct or decode one in the agent. */
export interface SnowflakeCursor<T> {
  /** Returns the next bounded page, or null when exhausted. */
  next(): Promise<T[] | null>;
}

export interface SqlColumn {
  name: string;
  type: string;
}

export interface SqlPage {
  columns: SqlColumn[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  queryId?: string;
}

export interface ReadOnlySqlOptions {
  /** Fully-qualified allowlisted database and schema context. */
  database: string;
  schema: string;
  /** Optional warehouse from the connection's allowlist. */
  warehouse?: string;
  /** Server-enforced maximum execution time in seconds. */
  timeoutSeconds?: number;
  /** Server-enforced maximum rows in the complete result. */
  maxRows?: number;
  /** Server-enforced maximum bytes in the complete result. */
  maxBytes?: number;
}

export interface ReadOnlySqlResult {
  queryId: string;
  columns: SqlColumn[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  elapsedMs: number;
}

export interface CortexAnalystRequest {
  /** The explicitly granted semantic view resource. */
  semanticView: string;
  question: string;
  /** Bound response size; citations remain structured and untrusted. */
  maxRows?: number;
}

export interface CortexAnalystResult {
  answer: string;
  generatedSql?: string;
  rows?: unknown[][];
  citations: Citation[];
  truncated: boolean;
}

export interface CortexSearchRequest {
  /** The explicitly granted Cortex Search service. */
  service: string;
  query: string;
  maxResults?: number;
}

export interface CortexSearchResult {
  results: SearchResult[];
  truncated: boolean;
}

export interface SearchResult {
  title: string;
  snippet: string;
  source?: string;
  score?: number;
}

export interface Citation {
  title: string;
  source?: string;
  locator?: string;
}

export interface CortexAgentRequest {
  /** Explicitly granted Cortex Agent identifier. */
  agent: string;
  message: string;
  maxResults?: number;
}

export interface CortexAgentResult {
  answer: string;
  citations: Citation[];
  /** Intermediate steps are bounded and treated as untrusted vendor output. */
  steps?: AgentStep[];
  truncated: boolean;
}

export interface AgentStep {
  kind: "tool_call" | "tool_result" | "citation";
  name?: string;
  summary: string;
}

export interface CustomToolSummary {
  name: string;
  title: string;
  description: string;
  kind: "udf" | "stored_procedure";
  /** Whether this tool is eligible for a separate approval policy. */
  approvalRequired: boolean;
}

export interface CustomToolRequest {
  /** Must be one of the connection's allowlisted tools. */
  tool: string;
  /** JSON-compatible arguments validated against the tool signature server-side. */
  arguments: Record<string, unknown>;
}

export interface CustomToolResult {
  tool: string;
  result: unknown;
  truncated: boolean;
}

export interface SnowflakeWriteProposal {
  proposalId: string;
  /** Sequential, Gatekeeper-assigned action id; the id the approval flow will call back with. */
  actionId: number;
  operation: "insert" | "update" | "merge";
  target: string;
  sql: string;
  simulated: boolean;
}

export interface SnowflakeSession {
  /** Return only the account identity and effective role, never credentials. */
  getAccount(): Promise<SnowflakeAccount>;

  listDatabases(): Promise<SnowflakeCursor<DatabaseSummary>>;
  listSchemas(database: string): Promise<SnowflakeCursor<SchemaSummary>>;
  listTables(database: string, schema: string): Promise<SnowflakeCursor<TableSummary>>;
  describeTable(database: string, schema: string, table: string): Promise<TableDescription>;

  /** Execute a bounded SELECT against the explicitly scoped database/schema. */
  runReadOnlySql(sql: string, options: ReadOnlySqlOptions): Promise<ReadOnlySqlResult>;
  cortexAnalyst(request: CortexAnalystRequest): Promise<CortexAnalystResult>;
  cortexSearch(request: CortexSearchRequest): Promise<CortexSearchResult>;
  /** Governed Snowflake Agent; recursion into this Gatekeeper is rejected. */
  runCortexAgent(request: CortexAgentRequest): Promise<CortexAgentResult>;

  listCustomTools(): Promise<SnowflakeCursor<CustomToolSummary>>;
  /**
   * Invoke an explicitly allowlisted UDF or stored procedure. Read-only tools return directly;
   * tools with externally visible effects are governed by the Gatekeeper action policy and do
   * not execute until the required approval has been granted.
   */
  runCustomTool(request: CustomToolRequest): Promise<CustomToolResult>;
  /** Queue a bounded DML proposal; it is never sent to Snowflake during this call. */
  proposeWrite(operation: "insert" | "update" | "merge", target: string, sql: string): Promise<SnowflakeWriteProposal>;
  /** Read the durable state of a previously proposed write, or null when unknown. */
  getWriteProposal(proposalId: string): Promise<SnowflakeWriteProposal | null>;
}`;

export default TYPES_CODE;
