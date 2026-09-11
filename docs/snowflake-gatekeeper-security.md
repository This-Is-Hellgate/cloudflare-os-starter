# Snowflake Gatekeeper: moderate security boundary

This document is the security checklist for a moderate Snowflake capability. It is a design
constraint, not an enablement switch. The Gatekeeper remains disabled until the checklist is
implemented and its tests pass.

The design follows the current `@gadgets/gatekeeper-kit` leaf modules. Layer 2 assembly is not
assumed to be shipped, so the Gatekeeper owns the provider-specific policy and RPC assembly.

## Intended moderate capability

The first moderate profile may expose:

- Snowflake-managed MCP `CORTEX_AGENT_RUN`, where the selected Cortex Agent is the governed
  client-facing interface.
- Explicitly selected `CORTEX_ANALYST_MESSAGE` and `CORTEX_SEARCH_SERVICE_QUERY` resources.
- `SYSTEM_EXECUTE_SQL` only through a separately scoped SQL MCP server/role, with
  `read_only: true`, a fixed warehouse, query timeout, and result limits.
- Allowlisted custom MCP `GENERIC` tools only after their UDF/stored-procedure signatures,
  effects, and roles are reviewed.
- Bounded write proposals for named procedures or statement templates. They go through
  `submitAction()` -> simulation/approval -> `applyAction()` -> provider verification; there is
  no general `executeSql` capability.

The Gatekeeper does not expose account administration, role/user management, secret management,
warehouse resizing, arbitrary UDF/procedure invocation, unrestricted DDL, `DROP`, or `TRUNCATE`.

## Security checklist

| Area | Required control | Test/evidence |
| --- | --- | --- |
| OAuth | Prefer Snowflake OAuth. Store grants only in the account Durable Object using the Gatekeeper Kit credential coordinator. Never return access/refresh tokens to a Gadget or model. | OAuth callback, refresh, revoke, expiry, and reconnect tests; logs contain no token or response body. |
| RBAC | Use a dedicated least-privilege Snowflake role. Grant MCP server access and each tool separately. Keep Cortex Agent, Analyst/Search, and SQL roles/resource scopes explicit. | Denied-role and denied-tool tests; captured role/tool policy is reviewed. |
| Resource scope | A connection names account, database/schema, warehouse, MCP server, and selected Cortex resources. Normalize identifiers and reject values outside the configured allowlist. | URL round-trip and scope-confusion tests; no account-wide fallback. |
| SQL injection | Do not concatenate user/model text into identifiers, SQL, or policy. Prefer Snowflake-managed semantic tools or server-defined statements. If a read-only SQL surface is required, validate statement class and enforce server-side `read_only`, timeout, warehouse, rows, bytes, and pagination limits. | Attempted comments, multi-statements, `CALL`, DDL/DML, identifier escapes, and oversized results are rejected. |
| Tool poisoning/shadowing | Treat MCP names, descriptions, schemas, and returned content as untrusted. Verify every third-party server and tool before allowlisting. Use namespaced IDs and do not merge same-named tools from multiple servers silently. | Catalog snapshot and approval record; collision and malicious-description tests. |
| Observations | Every provider read, including empty results, cursor pages, Cortex traces, citations, and metadata, is authorized after fetch and before return through `ObservationGate`. Escape provider-controlled strings. | Tests assert no data path returns without authorization; refusal and transient-failure behavior is distinct. |
| Sharing | Use `trackedCollectionObservers` for independently ACL'd databases/schemas/services, or reject observers when no reliable ACL oracle exists. Verify each observer with their own Snowflake identity. | Admission, revoked-role, and per-read observer-denial tests. |
| Action fences | Stage writes with the connection/authority fence from the read that caused the action. Apply only under the same authority generation (or explicitly documented stable account identity). | Reconnect-between-submit/apply test fails closed and cannot replay under the new grant. |
| Approval and simulation | Write proposals contain the exact statement/procedure, target scope, parameters, expected effect, and idempotency key. Simulation must project pending state or clearly mark unsupported effects. | Approve, reject, retry, terminal-unknown, and post-apply reconciliation tests. |
| Recursion | Reject circular paths such as Think -> Snowflake MCP -> Cortex Agent -> MCP -> Think. Maintain a per-request visited-server/tool set and depth/budget counter; never rely only on Snowflake's maximum depth. | Cycle test terminates with a safe error and bounded cost. |
| Rate and size limits | Bound tool calls, concurrent requests, query timeout, rows, bytes, page size, MCP response body, Cortex intermediate traces, citations, and retained action files. Snowflake Cortex Agent responses may exceed 200 KB. | Boundary tests at and over every limit; no unbounded buffering. |
| Network safety | Allowlist the Snowflake account hostname and exact MCP endpoint. Manual redirects; revalidate every `Location`; never forward Authorization across origins. | Redirect, alternate-host, underscore-hostname, and malformed URL tests. |
| Errors/logging | Return display-safe, typed errors. Cap/decode response bodies with `readTextCapped`; do not include SQL text, tokens, rows, traces, or vendor error bodies in logs unless explicitly redacted. | Log-scrubbing tests and provider error classification tests. |

## Tool policy

The policy is per connection, not a global boolean:

```text
snowflake.connection
  account: exact account host
  role: dedicated least-privilege role
  databases/schemas: explicit allowlist
  warehouses: explicit allowlist with timeout/budget
  mcpServers: reviewed endpoint IDs only
  tools:
    cortexAgent: named IDs only
    analyst: named semantic-view IDs only
    search: named service IDs only
    sql: separate server, read_only=true
    generic: reviewed signature IDs only
  writes: named action templates only, approval required
```

Snowflake recommends exposing a Cortex Agent as the single client-facing governed interface for
business questions. If direct SQL is needed, it should be separated behind its own MCP server and
least-privilege role so it cannot bypass the Agent's semantic views and orchestration.

## Authoritative references

- [Snowflake developer documentation](https://docs.snowflake.com/en/developer)
- [Snowflake-managed MCP server](https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-agents-mcp)
- [Snowflake SQL REST API](https://docs.snowflake.com/en/developer-guide/sql-api)
- [Gatekeeper Kit README](../cloudflare-os/packages/gatekeeper-kit/README.md)
- [Gatekeeper Kit usage guide](../cloudflare-os/packages/gatekeeper-kit/USAGE.md)
- [Current Gatekeeper Kit plan](../cloudflare-os/plans/gatekeeper-kit.md)

The Snowflake MCP documentation explicitly calls out OAuth preference, least-privilege PAT roles,
per-tool permissions, tool poisoning/shadowing, and recursive invocation risks. The controls above
make those requirements enforceable at the Cloudflare Gatekeeper boundary as well.
