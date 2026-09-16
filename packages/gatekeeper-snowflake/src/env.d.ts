interface Env {
  SNOWFLAKE_TOKEN: string;
  SNOWFLAKE_ACCOUNT: string;
  SNOWFLAKE_ROLE: string;
  /**
   * Operator identity recorded as the trusted approval subject's ownerId (approval provenance).
   * Defaults to "operator" when unset; it is metadata only and never grants authority.
   */
  SNOWFLAKE_USER?: string;
  SNOWFLAKE_DATABASES?: string;
  SNOWFLAKE_SCHEMAS?: string;
  SNOWFLAKE_TABLES?: string;
  SNOWFLAKE_WAREHOUSE?: string;
  /** Optional write-path role: when set, approved writes run under it instead of SNOWFLAKE_ROLE. */
  SNOWFLAKE_WRITE_ROLE?: string;
  /** Optional write-path warehouse, overriding SNOWFLAKE_WAREHOUSE for approved writes. */
  SNOWFLAKE_WRITE_WAREHOUSE?: string;
  SNOWFLAKE_BASE_URL?: string;
  SNOWFLAKE_MAX_ROWS?: string;
  SNOWFLAKE_MAX_BYTES?: string;
  /** Operator gate: when "true"/"1", approved Snowflake write actions are executed. */
  SNOWFLAKE_ENABLE_WRITES?: string;
  /** Comma-separated allowlist of DATABASE.SCHEMA.VIEW semantic views for Cortex Analyst. */
  SNOWFLAKE_CORTEX_SEMANTIC_VIEWS?: string;
  /** Comma-separated allowlist of DATABASE.SCHEMA.SERVICE Cortex Search services. */
  SNOWFLAKE_CORTEX_SEARCH_SERVICES?: string;
  /** Comma-separated write-function allowlist for governed writes; replaces the built-in default when set. */
  SNOWFLAKE_WRITE_FUNCTIONS?: string;
  /** JSON array of preauthorization patterns: [{name, operations, target, maxRows}]. Empty/absent = every write takes the approval queue. */
  SNOWFLAKE_WRITE_PREAUTHORIZATIONS?: string;
  /** Rows delivered per result page (docs profile: default 100, hard maximum 500). */
  SNOWFLAKE_RESULT_ROWS_PER_PAGE?: string;
  /** Service fetches one result cursor may make (docs profile: default 10, hard maximum 100). */
  SNOWFLAKE_MAX_RESULT_PAGES?: string;
}
declare module "*.d.ts?raw" { const text: string; export default text; }
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./index");
    durableNamespaces: "SnowflakeGatekeeper";
  }
}
