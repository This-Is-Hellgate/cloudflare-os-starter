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
}
declare module "*.d.ts?raw" { const text: string; export default text; }
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./index");
    durableNamespaces: "SnowflakeGatekeeper";
  }
}
