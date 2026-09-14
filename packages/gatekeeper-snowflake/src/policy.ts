/**
 * Snowflake capability policy: credential validation, allowlists, identifier rules, and the
 * shared write-proposal validation used by both fresh proposals and the approved-action
 * executor. Kept free of `cloudflare:workers` imports so the policy is unit-testable.
 */

export const MAX_SQL = 32_000;
export const MAX_QUESTION = 4_000;
const DEFAULT_ROWS = 1000;
const DEFAULT_BYTES = 2_000_000;
// Hard caps on operator-configured limits: a deployment may lower them, never raise them
// beyond a bounded ceiling, so a misconfigured value cannot unbound agent reads.
const MAX_ROWS_CAP = 10_000;
const MAX_BYTES_CAP = 10_000_000;
// The paging profile from docs/snowflake-gatekeeper.md: result pages carry at most 500 rows, and
// one cursor walk may fetch at most 100 pages. Defaults follow the same document.
const DEFAULT_ROWS_PER_PAGE = 100;
const DEFAULT_RESULT_PAGES = 10;
const MAX_ROWS_PER_PAGE_CAP = 500;
const MAX_RESULT_PAGES_CAP = 100;

export interface SnowflakePolicy {
  databases: Set<string>;
  schemas: Set<string>;
  tables: Set<string>;
  semanticViews: Set<string>;
  searchServices: Set<string>;
  maxRows: number;
  maxBytes: number;
  /** Rows delivered per result page (docs profile: 100 default, 500 hard maximum). */
  resultRowsPerPage: number;
  /** Service fetches one result cursor may make (docs profile: 10 default, 100 hard maximum). */
  maxResultPages: number;
}

const allow = (raw?: string) =>
  new Set((raw ?? "").split(",").map(x => x.trim().toUpperCase()).filter(Boolean));

function positiveInt(raw: string | undefined, fallback: number, cap: number): number {
  const n = Number(raw ?? fallback);
  return Number.isInteger(n) && n > 0 ? Math.min(n, cap) : fallback;
}

export function snowflakePolicy(env: Env): SnowflakePolicy {
  if (!env.SNOWFLAKE_TOKEN || !env.SNOWFLAKE_ACCOUNT || !env.SNOWFLAKE_ROLE) throw new Error("Snowflake credentials are not configured.");
  return {
    databases: allow(env.SNOWFLAKE_DATABASES),
    schemas: allow(env.SNOWFLAKE_SCHEMAS),
    tables: allow(env.SNOWFLAKE_TABLES),
    semanticViews: allow(env.SNOWFLAKE_CORTEX_SEMANTIC_VIEWS),
    searchServices: allow(env.SNOWFLAKE_CORTEX_SEARCH_SERVICES),
    maxRows: positiveInt(env.SNOWFLAKE_MAX_ROWS, DEFAULT_ROWS, MAX_ROWS_CAP),
    maxBytes: positiveInt(env.SNOWFLAKE_MAX_BYTES, DEFAULT_BYTES, MAX_BYTES_CAP),
    resultRowsPerPage: positiveInt(env.SNOWFLAKE_RESULT_ROWS_PER_PAGE, DEFAULT_ROWS_PER_PAGE, MAX_ROWS_PER_PAGE_CAP),
    maxResultPages: positiveInt(env.SNOWFLAKE_MAX_RESULT_PAGES, DEFAULT_RESULT_PAGES, MAX_RESULT_PAGES_CAP),
  };
}

/** Operator gate: when "true"/"1", approved Snowflake write actions are executed. */
export function writesEnabled(env: Env): boolean {
  return env.SNOWFLAKE_ENABLE_WRITES === "true" || env.SNOWFLAKE_ENABLE_WRITES === "1";
}

export function identifier(value: string, label: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(value)) throw new Error(`Invalid ${label}.`);
  return value.toUpperCase();
}

export function qualified(db: string, schema: string, table?: string): string {
  const d = identifier(db, "database"), s = identifier(schema, "schema");
  return table === undefined ? `${d}.${s}` : `${d}.${s}.${identifier(table, "table")}`;
}

/** Empty allowlist permits everything; a non-empty one matches the full name, or the last segment when the entry itself is a bare segment. */
export function allowed(set: Set<string>, value: string, label: string) {
  if (!set.size) return;
  const upper = value.toUpperCase();
  const last = upper.split(".").slice(-1)[0];
  for (const entry of set) {
    if (entry === upper) return;
    // A bare allowlist entry (no dots) grants by last segment; a qualified entry grants only by
    // exact full-name match, so OTHER.S.T can never ride on an allowlisted DB.S.T.
    if (!entry.includes(".") && entry === last) return;
  }
  throw new Error(`${label} is outside the configured allowlist.`);
}

export function boundedText(value: string, max: number, name: string): string {
  if (value.length > max) throw new Error(`${name} exceeds the ${max}-character limit.`);
  return value;
}

/** Server-enforced integer bound: 1..max, falling back when absent or malformed. */
export function boundedInt(value: number | undefined, fallback: number, max: number): number {
  const n = value ?? fallback;
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error("Requested limit is outside the allowed bound.");
  return n;
}

const OPERATIONS = new Set(["insert", "update", "merge"]);

/**
 * The single authority on whether a DML proposal may run, shared by fresh proposals and the
 * executor's re-validation of stored payloads. Returns the normalized, allowlist-checked target.
 */
export function validateWriteProposal(policy: SnowflakePolicy, operation: string, target: string, sql: string): { table: string; database: string; schema: string } {
  if (!OPERATIONS.has(operation)) throw new Error("Only bounded INSERT, UPDATE, or MERGE proposals are permitted.");
  const segments = target.split(".");
  if (segments.length !== 3) throw new Error("Write target must be DATABASE.SCHEMA.TABLE.");
  const table = qualified(segments[0], segments[1], segments[2]);
  allowed(policy.tables, table, "Table");
  if (!new RegExp(`^${operation}\\b`, "i").test(sql.trim()) || /\b(DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE|CALL|DELETE)\b/i.test(sql)) throw new Error("Only bounded INSERT, UPDATE, or MERGE proposals are permitted.");
  if (sql.length > MAX_SQL) throw new Error("SQL proposal exceeds the size limit.");
  return { table, database: identifier(segments[0], "database"), schema: identifier(segments[1], "schema") };
}
