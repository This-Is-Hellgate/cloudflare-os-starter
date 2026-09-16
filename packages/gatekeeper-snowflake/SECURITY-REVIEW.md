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

## Write surface (governed write grammar)

- **The plan is the authority.** `proposeWrite()` parses SQL with `parseWriteSql()` (parse-or-refuse)
  into a structured `WritePlan`; `proposePlan()` accepts the plan directly. The same
  `validateWritePlan()` authority runs at proposal time and again inside the executor against the
  stored record and the CURRENT policy: target must be exactly `DATABASE.SCHEMA.TABLE` and
  allowlisted, predicates are closed-world (comparisons, null checks, IN over bound values, bounded
  AND/OR/NOT), expressions allow operator-allowlisted functions only
  (`SNOWFLAKE_WRITE_FUNCTIONS` replaces the built-in default), empty update predicates and
  unconditional deletes are refused, and structure (rows, columns, plan steps, expression nodes) is
  hard-bounded. DDL and multi-statement scripts are outside the grammar entirely.
- **Values never interpolate into SQL.** The compiler emits canonical SQL with `?` placeholders and
  typed server-side bindings (TEXT/FIXED/REAL/BOOLEAN); the compiled SQL is a pure function of the
  journaled plan, so approved semantics and executed bytes cannot diverge.
- **Roles are forced, not suggested.** `SNOWFLAKE_ROLE` (and warehouse) are applied after the
  request body spread, so a request body cannot override them. When `SNOWFLAKE_WRITE_ROLE` /
  `SNOWFLAKE_WRITE_WAREHOUSE` are configured, approved writes run under them — reads stay on the
  read role. `INSERT ... SELECT` materializes the subquery through the READ role first (row/byte
  ceilings), then binds the returned rows into the approved INSERT; subqueries never execute inside
  the write.
- **Row ceilings.** Structural row counts (INSERT rows, MERGE sources, materialized reads) are
  hard-enforced. Predicate mutations (UPDATE/DELETE) carry an advisory COUNT(*) preflight that
  refuses writes whose count already exceeds the approved ceiling; the documented race means the
  preflight is a guard, not a guarantee, and the executed row count is journaled.
- **Preauthorizations.** `SNOWFLAKE_WRITE_PREAUTHORIZATIONS` holds operator-installed patterns
  (name, operation, target, row ceiling). The match is evaluated DO-side against the stored payload
  only; a matching write is approved with `preauthorized:<name>` provenance recorded on the Stage
  record and executed inline. Session code can never select a pattern by flag.
- **Operator SQL.** `applyOperatorSql()` stages operator-authored SQL (bounded, single-statement,
  write-gate required), records `operator` provenance, journals it through the same execution
  journal, and is NOT exposed on the agent-facing session types. The model may draft SQL into a
  proposal description; drafting is not authority.
- **Journaling and retries.** Every write carries a stable per-action requestId (Snowflake returns
  the original status for a repeated requestId instead of re-executing) plus the vendor's
  statement handle, journaled as receipt evidence. Mid-plan failures record the applied statement
  handles in the surfaced error. Legacy free-form records are refused with an explicit migration
  message (`refuseLegacySqlWrite()`), never silently reinterpreted.
- **Honest state.** `getWriteProposal()` reports `simulated: settled !== "succeeded"` — a recorded
  approval decision alone does not mean the statement ran; the execution journal's settled attempt
  is the proof.
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
