interface Env {
  SNOWFLAKE_TOKEN: string;
  SNOWFLAKE_ACCOUNT: string;
  SNOWFLAKE_ROLE: string;
  SNOWFLAKE_DATABASES?: string;
  SNOWFLAKE_SCHEMAS?: string;
  SNOWFLAKE_TABLES?: string;
  SNOWFLAKE_WAREHOUSE?: string;
  SNOWFLAKE_BASE_URL?: string;
  SNOWFLAKE_MAX_ROWS?: string;
  SNOWFLAKE_MAX_BYTES?: string;
  /** Operator gate: when "true"/"1", approved Snowflake write actions are executed. */
  SNOWFLAKE_ENABLE_WRITES?: string;
  /** Comma-separated allowlist of DATABASE.SCHEMA.VIEW semantic views for Cortex Analyst. */
  SNOWFLAKE_CORTEX_SEMANTIC_VIEWS?: string;
  /** Comma-separated allowlist of DATABASE.SCHEMA.SERVICE Cortex Search services. */
  SNOWFLAKE_CORTEX_SEARCH_SERVICES?: string;
}
declare module "*.d.ts?raw" { const text: string; export default text; }
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./index");
    durableNamespaces: "SnowflakeGatekeeper";
  }
}
