# Snowflake Gatekeeper — moderate-tier API review

This is the Phase 1 design boundary. It describes the agent-facing capability only; it does not
enable a Worker, request Snowflake credentials, or implement a runtime.

| Topic | Proposal |
|---|---|
| Resource scopes | A connection is narrowed to an account plus explicit database/schema, table/view/semantic-view, Cortex Search service, Cortex Agent, and named custom-tool resources. A resource URL identifies the selected scope. Warehouse names are allowlisted connection metadata, not arbitrary input. |
| Read capabilities | Account/role metadata; bounded database/schema/table discovery; table descriptions; `SELECT`-only SQL with server limits; Cortex Analyst on selected semantic views; Cortex Search on selected services; Cortex Agent on selected agents; discovery and invocation of explicitly allowlisted custom tools. Every read, cursor page, and vendor response is observation-authorized. |
| Write capabilities | Moderate tier permits explicitly allowlisted mutating stored procedures/UDFs through `runCustomTool`; the Gatekeeper routes side-effecting calls through its internal action queue, simulation, approval, idempotency fence, and post-action verification. Direct arbitrary SQL, DDL, account administration, role/user management, warehouse resizing, and secret management are excluded. |
| URL patterns | `https://snowflake.local/account/{account}/database/{database}/schema/{schema}`; `https://snowflake.local/account/{account}/semantic-view/{database}/{schema}/{name}`; `https://snowflake.local/account/{account}/search-service/{database}/{schema}/{name}`; `https://snowflake.local/account/{account}/cortex-agent/{database}/{schema}/{name}`; and `https://snowflake.local/account/{account}/custom-tool/{database}/{schema}/{name}`. These are capability selectors, not network destinations. |
| Sharing | Use `trackedCollectionObservers`: database/schema/table and named Cortex resources are disclosed collections. `addObserver` must use the observer's own Snowflake credential verifier to check baseline and each disclosed collection. Transient Snowflake failures rethrow; they never become an allow decision. |
| Trade-offs | Moderate capability is useful for governed analytics and controlled operations, but custom tools and Cortex Agent responses can contain large/untrusted payloads, so all responses are bounded and summarized. Direct SQL remains separate from Cortex Agent exposure in accordance with Snowflake guidance. No PATs in the normal flow; OAuth is required. |

## External documentation basis

Snowflake documents the managed MCP tool types as Cortex Agent, Cortex Search, Cortex Analyst,
SQL execution, and generic UDF/stored-procedure tools. It recommends OAuth, per-tool RBAC, and
avoiding recursive MCP configurations. It also warns that exposing direct SQL beside a governed
Cortex Agent can bypass semantic views and orchestration, so a production deployment should use
separate least-privilege server/role boundaries for those capabilities.

See the [Snowflake developer guide](https://docs.snowflake.com/en/developer) and
[Snowflake-managed MCP server documentation](https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-agents-mcp).

## Required implementation controls

| Area | Required control | Evidence |
|---|---|---|
| OAuth/RBAC | Snowflake OAuth and a dedicated least-privilege role; grant MCP-server and tool permissions separately. Never return tokens. | Connect, refresh, revoke, expiry, denied-role, and denied-tool tests. |
| SQL safety | Separate SQL server/role; validate SELECT-only input and enforce server-side warehouse, timeout, row, byte, and pagination caps. | Multi-statement, CALL, DDL/DML, escape, and oversized-result tests. |
| Tool trust | Verify every MCP server/tool before allowlisting. Treat names, descriptions, schemas, and results as untrusted and namespace collisions. | Catalog snapshot, poisoning, and shadowing tests. |
| Observations | Authorize every provider read, cursor page, citation, trace, and metadata response through `ObservationGate` after fetch and before return. | No-data-without-authorization tests; refusal differs from transient failure. |
| Actions | Side-effecting custom tools and named mutation templates use `submitAction()` / simulation / `applyAction()` with authority fences and post-action verification. | Approval, rejection, retry, reconnect-race, idempotency, and reconciliation tests. |
| Sharing | `trackedCollectionObservers` checks each observer's own Snowflake identity for every disclosed collection; uncertain access fails closed. | Admission, revoked-role, and per-read denial tests. |
| Recursion/network | Reject circular MCP paths and enforce visited-server/tool, depth, and cost budgets. Allowlist the account host and exact endpoint; revalidate redirects. | Cycle, redirect, alternate-host, and malformed-URL tests. |
| Bounds/logging | Cap MCP bodies, Cortex intermediate traces, citations, action files, and concurrent calls. Redact SQL, tokens, rows, traces, and vendor bodies from logs. | Boundary and log-scrubbing tests. |
