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

/** Default affected-row ceiling for predicate-based writes; the hard cap is in write-plan.ts. */
const DEFAULT_WRITE_MAX_ROWS = 1_000;
const MAX_WRITE_MAX_ROWS = 100_000;
const MAX_PREAUTHORIZATION_CHARS = 16_000;
const MAX_PREAUTHORIZATIONS = 50;

/** The default governed write-function allowlist; SNOWFLAKE_WRITE_FUNCTIONS replaces it when set. */
export const DEFAULT_WRITE_FUNCTIONS = [
  "UPPER", "LOWER", "LENGTH", "LEFT", "RIGHT", "TRIM", "CONCAT", "COALESCE",
  "ABS", "ROUND", "FLOOR", "CEIL", "MOD", "NULLIF", "CAST",
];

/** One operator-installed preauthorization: a narrowly defined, recorded preapproval pattern. */
export interface WritePreauthorization {
  /** Recorded as approval provenance on every action it covers. */
  name: string;
  /** Exact governed operation, "plan" for multi-step plans, or "any". */
  operations: "any" | "insert" | "update" | "delete" | "merge" | "insert_select" | "plan";
  /** Exact DATABASE.SCHEMA.TABLE (uppercased), or a bare last-segment entry (same semantics as the table allowlist). */
  target: string;
  /** The mutation's own row ceiling must be at or under this bound. */
  maxRows: number;
}

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
  /** The governed write-function allowlist (write-plan.ts refuses calls outside it). */
  writeFunctions: Set<string>;
  /** Operator-installed preauthorization patterns; empty means every write takes the approval queue. */
  preauthorizations: WritePreauthorization[];
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
    writeFunctions: writeFunctionAllowlist(env.SNOWFLAKE_WRITE_FUNCTIONS),
    preauthorizations: parsePreauthorizations(env.SNOWFLAKE_WRITE_PREAUTHORIZATIONS),
  };
}

function writeFunctionAllowlist(raw: string | undefined): Set<string> {
  const configured = allow(raw);
  return configured.size ? configured : new Set(DEFAULT_WRITE_FUNCTIONS);
}

function parsePreauthorizations(raw: string | undefined): WritePreauthorization[] {
  if (!raw) return [];
  if (raw.length > MAX_PREAUTHORIZATION_CHARS) throw new Error("SNOWFLAKE_WRITE_PREAUTHORIZATIONS exceeds the configuration size bound.");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("SNOWFLAKE_WRITE_PREAUTHORIZATIONS is not valid JSON."); }
  if (!Array.isArray(parsed) || parsed.length > MAX_PREAUTHORIZATIONS) throw new Error(`SNOWFLAKE_WRITE_PREAUTHORIZATIONS must be an array of at most ${MAX_PREAUTHORIZATIONS} patterns.`);
  return parsed.map((entry, i): WritePreauthorization => {
    const e = entry as Partial<WritePreauthorization>;
    if (typeof e?.name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(e.name)) throw new Error(`Preauthorization ${i}: name must match [A-Za-z0-9_-]{1,64}.`);
    if (typeof e?.target !== "string" || !e.target || e.target.length > 255 || /"/.test(e.target)) throw new Error(`Preauthorization ${i}: target must be DATABASE.SCHEMA.TABLE or a bare table segment.`);
    const ops = e?.operations ?? "any";
    if (!["any", "insert", "update", "delete", "merge", "insert_select", "plan"].includes(ops)) throw new Error(`Preauthorization ${i}: unknown operations value.`);
    const maxRows = typeof e?.maxRows === "number" ? e.maxRows : DEFAULT_WRITE_MAX_ROWS;
    if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > MAX_WRITE_MAX_ROWS) throw new Error(`Preauthorization ${i}: maxRows must be 1-${MAX_WRITE_MAX_ROWS}.`);
    return { name: e.name, operations: ops as WritePreauthorization["operations"], target: e.target.toUpperCase(), maxRows };
  });
}

/**
 * DO-side preauthorization evaluation: every mutation in the plan must match the SAME pattern
 * (operation, target, and the mutation's own ceiling within the pattern's bound). Returns the
 * recorded pattern name, or null when the write must take the approval queue. Evaluated against
 * the stored payload only — session code can never select a pattern by flag.
 */
export function matchesPreauthorization(policy: SnowflakePolicy, plan: import("./write-plan.js").WritePlan): string | null {
  if (!policy.preauthorizations.length) return null;
  const mutations = plan.operation === "plan" ? plan.steps.map((s) => s.mutation) : [plan];
  for (const pattern of policy.preauthorizations) {
    const fits = mutations.every((m) => {
      const opOk = pattern.operations === "any" || pattern.operations === (plan.operation === "plan" ? "plan" : m.operation);
      const target = m.target.toUpperCase();
      const last = target.split(".").slice(-1)[0];
      const targetOk = pattern.target === target || (!pattern.target.includes(".") && pattern.target === last);
      return opOk && targetOk && (m as { maxRows?: number }).maxRows !== undefined && (m as { maxRows: number }).maxRows <= pattern.maxRows;
    });
    if (fits) return pattern.name;
  }
  return null;
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

const OPERATIONS = new Set(["insert", "update", "merge", "delete", "insert_select", "plan", "operator_sql"]);

/**
 * Legacy free-form SQL gate. The governed surface is validateWritePlan (write-plan.ts); this
 * remains as the explicit refusal for any code path still carrying raw SQL, with a migration
 * message instead of silent reinterpretation.
 */
export function refuseLegacySqlWrite(): never {
  throw new Error("Free-form write SQL is no longer accepted. Propose through the governed write grammar (proposeWrite/proposePlan): structured insert, update, delete, merge, insert_select, or an ordered plan with bound values.");
}

/**
 * The single authority on whether a DML proposal may run, shared by fresh proposals and the
 * executor's re-validation of stored payloads. Returns the normalized, allowlist-checked target.
 */
export function validateWriteProposal(policy: SnowflakePolicy, operation: string, target: string, sql: string): { table: string; database: string; schema: string } {
  if (!OPERATIONS.has(operation)) throw new Error("Only bounded INSERT, UPDATE, DELETE, MERGE, or plan proposals are permitted.");
  const segments = target.split(".");
  if (segments.length !== 3) throw new Error("Write target must be DATABASE.SCHEMA.TABLE.");
  const table = qualified(segments[0], segments[1], segments[2]);
  allowed(policy.tables, table, "Table");
  if (!new RegExp(`^${operation}\\b`, "i").test(sql.trim()) || /\b(DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE|CALL|DELETE)\b/i.test(sql)) throw new Error("Only bounded INSERT, UPDATE, DELETE, MERGE, or plan proposals are permitted.");
  if (sql.length > MAX_SQL) throw new Error("SQL proposal exceeds the size limit.");
  return { table, database: identifier(segments[0], "database"), schema: identifier(segments[1], "schema") };
}
