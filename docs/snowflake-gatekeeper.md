# Snowflake Gatekeeper: moderate capability profile

This document is the design boundary for a future Snowflake Gatekeeper. It is
documentation only: it does not create a Worker, enable a binding, or grant
Snowflake privileges. Implementation must follow the outer repository's
[`write-gatekeeper` guidance](customization.md#custom-gatekeepers) and the
reviewed `@gadgets/gatekeeper-kit` leaves.

The connector targets Snowflake's managed MCP server. Snowflake exposes five
server-side tool types: Cortex Agent, Cortex Analyst, Cortex Search, SQL
execution, and generic UDF/stored-procedure tools. See the [Snowflake managed
MCP documentation](https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-agents-mcp).

## Moderate tool allowlist

The Gatekeeper must discover the server's advertised tools, then intersect them
with this explicit per-connection allowlist. A discovered tool is never enabled
merely because it exists on the server.

| Gatekeeper capability | Snowflake MCP type | Moderate behavior |
| --- | --- | --- |
| `runCortexAgent` | `CORTEX_AGENT_RUN` | Enabled for explicitly selected Agent identifiers. The Agent's own Analyst/Search/custom-tool configuration remains the authority boundary. Bound response size and timeout. |
| `cortexAnalyst` | `CORTEX_ANALYST_MESSAGE` | Enabled for explicitly selected semantic views. The managed server supports semantic views, not semantic models. Return structured answer/SQL/citations with size limits. |
| `cortexSearch` | `CORTEX_SEARCH_SERVICE_QUERY` | Enabled for explicitly selected Search Services. Bound `max_results`, query length, and response bytes. |
| `runReadOnlySql` | `SYSTEM_EXECUTE_SQL` | Enabled only through a separately configured SQL MCP server/role. Require `read_only: true`, an allowlisted warehouse, timeout, row/byte limits, and a statement policy rejecting writes, DDL, session mutation, multi-statement input, and calls to unapproved procedures. |
| `runApprovedCustomTool` | `GENERIC` | Enabled only for individually named, reviewed UDFs or stored procedures. UDFs may be directly callable when read-only by review; procedures are proposal-only unless explicitly marked idempotent and approved. Never expose arbitrary identifiers. |
| `describeSnowflakeResource` | server metadata / controlled SQL | Read-only discovery limited to granted databases, schemas, tables/views, semantic views, Search Services, Agents, warehouses, and MCP server metadata. Every returned page is an authorized observation. |

Snowflake recommends presenting a governed Cortex Agent as the client-facing
tool, and placing direct SQL behind a separate MCP server and least-privilege
role because direct SQL can bypass the Agent's semantic views and orchestration.
That recommendation is retained here even though the profile is moderate.

Cortex Agent calls use the Snowflake `agent:run` API with an explicitly granted
agent object and bounded thread/run identifiers. The connection role must have
the required Cortex user/agent role, privilege on the agent object, and access
to every configured tool resource. Agent orchestration budgets and per-user
quotas are deployment limits, not model instructions. See the [Cortex Agents
documentation](https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-agents).

## Resource scopes

Every connection URL carries a concrete capability grant rather than an
account-wide credential. The selector must require:

- one Snowflake account URL and one managed MCP server object;
- an allowlist of Agent, semantic-view, Search-Service, SQL-server, warehouse,
  database, schema, table/view, UDF, and procedure identifiers as applicable;
- a maximum warehouse size or an already approved warehouse name;
- per-tool enablement, independent of the Snowflake server's advertised list;
- a role selected by the user and verified to be no broader than the grant.

The Gatekeeper must reject identifiers outside the grant, normalize and
validate the account endpoint, disallow redirects to another origin, and never
return OAuth tokens, PATs, SQL credentials, or raw authorization headers.

Snowflake privileges are separate for the server and each underlying tool:
`USAGE` on the MCP server is not sufficient by itself. The deployment role
must receive only the required `USAGE`, `SELECT`, or tool-specific privilege;
do not grant the access role to `PUBLIC` or future tables broadly. See
[Snowflake access control](https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-agents-mcp#access-control).

## Limits and input policy

The following are binding-level defaults and must be configurable only within
operator-approved maxima:

| Limit | Default | Hard maximum |
| --- | ---: | ---: |
| Query timeout | 120 seconds | 600 seconds |
| Search results | 25 | 100 |
| SQL result rows per page | 100 | 500 |
| SQL result bytes | 512 KiB | 4 MiB |
| MCP response bytes | 1 MiB | 4 MiB |
| Query/input length | 16 KiB | 64 KiB |
| Pages per cursor walk | 10 | 100 |
| Concurrent Snowflake calls per session | 2 | 4 |
| Generic tool calls per action | 1 | 1 |

The managed SQL tool's `read_only` option must remain true for direct SQL.
Reject comments, multiple statements, transaction/session-control commands,
file stages, external functions, and dynamic identifiers unless the reviewed
tool contract explicitly needs them. These checks complement Snowflake RBAC;
they do not replace it.

Use Gatekeeper Kit `response-body`, `endpoint`, `cursors`, `cache`, and
`observations` leaves where applicable. Treat tool descriptions, result text,
citations, identifiers, and error bodies as untrusted provider data.

## Approval, simulation, and writes

Moderate does not mean unrestricted execution. The read/write split is:

| Operation | Behavior |
| --- | --- |
| Agent, Analyst, Search, metadata, and read-only SQL | Fetch, authorize the exact observation, then return bounded structured data. |
| Reviewed read-only UDF | Same as a read, but only after the UDF is explicitly allowlisted and its side-effect status is documented. |
| Stored procedure, INSERT/UPDATE/MERGE/DELETE, DDL, task/pipe changes, or any uncertain tool | `propose → simulate → request approval → apply → verify`; never execute from the read path. |
| Destructive or administrative action (`DROP`, `TRUNCATE`, role/user grants, secret/key changes, warehouse resizing) | Not part of moderate; reject as unsupported. |

Actions use Gatekeeper Kit `defineActions`/journal semantics and an authority
fence tied to the credential generation and Snowflake role. The action payload
must include the exact server/tool identifier, normalized scope, SQL or
procedure name, bounded inputs, and an idempotency key derived from the stable
action ID. Simulation must project pending changes accurately or declare the
effect incomplete; rejection must remove the provisional state. Apply must
re-check the fence immediately before the provider call and verify the result
afterward.

## OAuth and connection requirements

Use Snowflake OAuth 2.0 by default. External OAuth may be supported later when
the issuer, audience, and token claims are configured explicitly. Dynamic client
registration is not supported by Snowflake's managed MCP server, so the client
ID/secret are deployment configuration secrets and each human authenticates
individually. See [Snowflake OAuth setup](https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-agents-mcp#set-up-oauth-authentication).

Credential handling must use the Gatekeeper Kit `credentials` and
`credential-expiry` leaves: durable refresh fencing, refresh coalescing,
display-safe errors, revocation, and generation invalidation. PATs and key-pair
JWTs are fallback modes requiring an explicit operator decision; never place
them in `deployment.jsonc` or expose them to a Gadget.

## Recursion and tool poisoning controls

Before enabling a connection, snapshot and review `tools/list` names,
descriptions, identifiers, and configuration. Reject duplicate/shadowing names,
unexpected endpoint changes, and generic tools not present in the grant.

The Gatekeeper must detect cycles in the call chain, including:

`Think agent → Snowflake MCP → Cortex Agent → MCP server → Cortex Agent`.

Carry a request chain ID, visited server/tool set, and depth budget. Refuse a
cycle or any request beyond depth 8, leaving margin below Snowflake's documented
maximum recursion depth of 10. Do not allow a Cortex Agent exposed through one
connection to call the same connection recursively. Snowflake's security
guidance also warns about tool poisoning/tool shadowing and circular invocation;
see the [managed MCP security recommendations](https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-agents-mcp#mcp-server-security-recommendations).

## Observations and sharing

Every session method and every cursor page that returns Snowflake data must
authorize the exact observation before returning it. Use
`trackedCollectionObservers` for database/schema/table and Search-Service
disclosures when the provider can distinguish collaborator access; use a
baseline check only for resources whose ACL is genuinely binding-wide. If an
observer cannot be checked with its own Snowflake identity, reject sharing
rather than claim it is safe.

Descriptions must escape provider-controlled names and must not include SQL
secrets, raw queries containing sensitive literals, tokens, or unbounded result
content. Observation scope should name the database/schema/table or named
semantic/Search resource actually disclosed.

## Pre-implementation review gate

Before a Worker is created, the implementation proposal must provide:

1. `types.d.ts` for the narrow RPC API and resource URL shape;
2. the exact OAuth scopes and Snowflake role grants;
3. the enabled tool identifiers and per-tool limits;
4. the read/write inventory and simulation model;
5. the observer verifier strategy;
6. tests for authorization denial, tool-list poisoning, recursion, bounds,
   approval/rejection, credential rotation, and observer access.

This document records the moderate policy; it is not approval to deploy or to
grant Snowflake access.
