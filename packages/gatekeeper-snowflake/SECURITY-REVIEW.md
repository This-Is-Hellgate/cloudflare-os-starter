# Snowflake Gatekeeper — Security Review

## Status

Reviewed as part of the Snowflake lane hardening. The package implements a governed Snowflake
capability: bounded metadata reads, bounded read-only SQL, Cortex Analyst/Search behind explicit
allowlists, and approval-gated DML through the shared Stage action ledger.

## Credential and role policy

- `SNOWFLAKE_TOKEN`, `SNOWFLAKE_ACCOUNT`, and `SNOWFLAKE_ROLE` are required; `snowflakePolicy()`
  fails closed when any is missing.
- The configured role is sent explicitly on every statement (`role` field on
  `/api/v2/statements`), so the advertised capability role actually governs execution instead of
  silently falling back to the credential's default role.
- Auth uses a bearer token header; the account base URL defaults to
  `https://<account>.snowflakecomputing.com` and can be overridden with `SNOWFLAKE_BASE_URL`.

## Read surface

- `SHOW DATABASES` / `SHOW SCHEMAS` / `SHOW TABLES` / `DESCRIBE TABLE` metadata, capped at 1000
  rows per call, narrowed by the `SNOWFLAKE_DATABASES` / `SNOWFLAKE_SCHEMAS` / `SNOWFLAKE_TABLES`
  allowlists.
- `runReadOnlySql` accepts only bounded `SELECT` statements (keyword blocklist for DML/DDL/PUT/GET),
  requires allowlisted database and schema, and enforces row/byte ceilings from policy
  (`SNOWFLAKE_MAX_ROWS` ≤ 10 000, `SNOWFLAKE_MAX_BYTES` ≤ 10 000 000). Whole rows are dropped until
  the payload fits the byte budget; `truncated` reports the clipping honestly. Its behavior is
  unchanged by the paging capability below.
- `runReadOnlySqlPages` walks the same bounded SELECT across Snowflake's result partitions. The
  contract was verified against the official SQL API reference: the initial response reports
  `resultSetMetaData.numRows` (the true total) and `partitionInfo[]` (each partition's rowCount),
  and further partitions are retrieved with `GET /api/v2/statements/{handle}?partition={n}`.
  Cumulative budgets are identical to the single-shot form; deliveries are sliced to
  `SNOWFLAKE_RESULT_ROWS_PER_PAGE` (≤ 500) and the cursor's service fetches are bounded by
  `SNOWFLAKE_MAX_RESULT_PAGES` (≤ 100), matching the docs profile. The capability is a real RPC
  object minted inside the governed session (allowlist checks, per-page observation
  authorization), with walk mechanics delegated to `@gadgets/cursor`.
- Allowlist semantics: an empty set permits everything; a qualified entry (`DB.S.T`) matches only
  the exact full name; a bare entry (`T`) matches by last segment. `OTHER.S.T` can never ride on an
  allowlisted `DB.S.T`.

## Cortex surface

- Cortex Analyst (`/api/v2/cortex/analyst/message`) and Cortex Search
  (`/api/v2/databases/{db}/schemas/{sch}/cortex-search-services/{svc}:query`) both fail closed
  unless `SNOWFLAKE_CORTEX_SEMANTIC_VIEWS` / `SNOWFLAKE_CORTEX_SEARCH_SERVICES` are configured.
- Targets must be fully qualified three-part names and pass the allowlist check; questions and
  queries are bounded (`MAX_QUESTION` = 4 000 chars); search result count is bounded (≤ 100).
- Analyst-generated SQL is auto-executed only when its schema is allowlisted and the statement
  passes the same bounded-SELECT guard; otherwise the statement is returned unexecuted.

## Write surface

- Fresh proposals and the executor share one validation authority, `validateWriteProposal()`:
  operation must be `insert`/`update`/`merge`, target must be `DATABASE.SCHEMA.TABLE` and
  allowlisted, SQL must start with the declared operation, must not contain destructive keywords
  (DROP/TRUNCATE/ALTER/CREATE/GRANT/REVOKE/CALL/DELETE), and must fit `MAX_SQL` (32 000 chars).
- Proposals are staged in the shared Stage ledger, submitted to the human approval queue with
  `awaitDecision: true` (writes are not simulated, so the agent pauses), and rolled back
  (`discardStagedWrite`) if submission fails.
- Execution is double-gated: a human approval **and** the `SNOWFLAKE_ENABLE_WRITES` operator flag.
  `applyAction` is idempotent for overseer re-delivery, re-validates the stored payload through the
  same policy before any remote call, and marks the record approved only after the remote write
  succeeds. `findWriteByProposalId` reports `simulated: record.state !== "approved"` — honest state.
- Reverts are refused (`implementsRevert: false`); Snowflake actions are not auto-reversible.

## Exclusions

- Cortex Agent and custom tools remain disabled pending recursion and per-tool allowlist design.
- Interactive account connect and the resource configurator are not enabled; the deployment
  credential is the only auth path.

## Sources

- Snowflake SQL API: `POST /api/v2/statements` (statement, role, warehouse, database, schema,
  timeout, bindings).
- Cortex Analyst: `POST /api/v2/cortex/analyst/message` (messages, semantic_view).
- Cortex Search: `POST /api/v2/databases/{db}/schemas/{sch}/cortex-search-services/{svc}:query`
  (query, columns, filter, limit).
