# Optional Gatekeeper catalog

The Starter has one deployment boundary: `deployment.jsonc` in the outer
`cloudflare-os-starter` repository. The nested `cloudflare-os` checkout is the reviewed upstream
source baseline and is not a second application checkout.

`scripts/deployment-config.ts` contains the metadata catalog for optional Gatekeepers. Each entry
has a stable ID, package directory, Router binding, URL prefix, and authentication shape. The
configuration file contains an explicit enablement and Worker name for every entry; all are
disabled by default.

This first milestone deliberately does not deploy these integrations. Before an entry is enabled,
the deployment generator must add its Worker config and both service bindings (Workshop RPC and
Router HTTP), verify its package-level Wrangler configuration, and define its secret/configuration
contract. A disabled entry must not create a Worker, binding, credential requirement, or public
route.

Planned entries:

| ID | Package | Authentication shape |
| --- | --- | --- |
| `github` | upstream `gatekeeper-github` | OAuth 2.0 |
| `confluence` | upstream `gatekeeper-confluence` | OAuth 2.0 |
| `cloudflare` | upstream `gatekeeper-cloudflare` | OAuth 2.0 |
| `mcp` | upstream `gatekeeper-mcp` | User-supplied endpoint |
| `mcpPortal` | upstream `gatekeeper-mcp-portal` | Admin-configured portal |
| `snowflake` | outer `packages/gatekeeper-snowflake` (implemented, not yet deployed) | Snowflake-scoped credentials |
| `huggingface` | outer `packages/gatekeeper-huggingface` (implemented, in the metadata catalog, not yet deployed) | Fine-grained Hub token / OAuth |

## Unified implementation plan

All integrations use the same Gatekeeper contract and are implemented in the outer Starter
repository. Each connector must provide a scoped resource URL, configurator, bounded observations,
approval-gated writes, simulation, idempotency, and observer verification before enablement.

- GitHub: repository/branch-scoped source reads, diffs, issues, pull-request proposals, and approved
  commits/pushes. No organization administration or unrestricted repository access.
- Confluence: site/space/page-scoped reads and approved page updates. No tenant-wide administration.
- Cloudflare: account/resource-scoped Workers, KV, R2, and observability operations. No account-wide
  token handling, billing, or unrestricted destructive actions.
- MCP: explicitly configured endpoint with normalized URL, tool allowlist, bounded results, and
  poisoning/shadowing defenses. No arbitrary endpoint discovery.
- MCP Portal: admin-selected portal only, with reviewed tools and authentication mode. No implicit
  portal trust.
- Snowflake: moderate Cortex/MCP and SQL capabilities with explicit role/database/schema/table
  scopes, approval-gated mutations, and recursion protection.
- Hugging Face: model/dataset/Space-scoped Hub access, bounded inference, and approval-gated
  repository/Space changes. No bucket or object-storage access.

AI Gateway model testing remains a separate path for Hugging Face inference and does not alter the
Think agent's model configuration.

No secret belongs in `deployment.jsonc`. OAuth client credentials, MCP tokens, and Snowflake
credentials will be installed through Wrangler secret/configuration flows after the corresponding
Gatekeeper has passed its capability, observer, action-fence, and bounded-I/O tests.
