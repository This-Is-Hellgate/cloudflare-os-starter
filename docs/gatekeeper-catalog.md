# Optional Gatekeeper catalog

The Starter has one deployment boundary: `deployment.jsonc` in the outer `cloudflare-os-starter` repository. The `cloudflare-os` directory is the vendored upstream source baseline — synced from the official repository by `.github/workflows/sync-upstream.yml` and verified against the recorded pin by `pnpm check:boundary` — and is not a second application checkout.

`scripts/deployment-config.ts` contains the metadata catalog for optional Gatekeepers. Each entry
carries the full service graph: stable ID, package directory, Router binding, URL prefix,
authentication shape, `publicFlow`, the Vendor entrypoint the Workshop binds, and the Worker's
secret contract. The configuration file contains an explicit enablement and Worker name for every
entry; all are disabled by default.

Every entry is wired into the deployment generator. Enabling one in `deployment.jsonc` (with a
Worker name) emits its Worker config from the package's **own** `wrangler.jsonc` — bindings, DO
migrations, compatibility flags, and rules travel with the package untouched — adds the service
bindings, and lists its required secrets so wrangler refuses to deploy until they are installed.
Enabling an entry outside the catalog is rejected loudly. A disabled entry must not create a
Worker, binding, credential requirement, or public route.

| ID | Package | Authentication shape | Required secrets | Required config |
| --- | --- | --- | --- | --- |
| `github` | upstream `gatekeeper-github` | OAuth 2.0 (per-user GitHub account) | `CLIENT_ID`, `CLIENT_SECRET` (from the package's `deploy-inputs.json`) | — |
| `confluence` | upstream `gatekeeper-confluence` | OAuth 2.0 (per-user Confluence site) | `CLIENT_ID`, `CLIENT_SECRET` | — |
| `cloudflare` | upstream `gatekeeper-cloudflare` | OAuth 2.0 | `CLIENT_ID`, `CLIENT_SECRET` | — |
| `mcpv2` | upstream `gatekeeper-mcp` (deployed under the mcpv2 identity) | User-supplied MCP endpoint | — | — |
| `mcpPortal` | upstream `gatekeeper-mcp-portal` | Admin-configured portal | `MCP_PORTAL_TOKEN` only when `MCP_PORTAL_AUTH=token` (documented, not in the hard contract) | `MCP_PORTAL_URL` (`gatekeepers.mcpPortal.vars`) |
| `snowflake` | outer `packages/gatekeeper-snowflake` | Snowflake-scoped credentials | `SNOWFLAKE_ACCOUNT`, `SNOWFLAKE_TOKEN`, `SNOWFLAKE_ROLE` (+ `SNOWFLAKE_WRITE_TOKEN` when write authority is enabled) | — |
| `huggingface` | outer `packages/gatekeeper-huggingface` | Fine-grained Hub token / OAuth | `HF_TOKEN` | — |

## Service graph rules

- **`publicFlow` decides the Router HTTP flow only.** Every current entry is public (`true`): the
  Router exposes `/gatekeeper/<prefix>` (OAuth redirects land there). The Workshop vendor-RPC
  service binding exists either way. Future control/runtime/factory Workers (P6/P7) carry
  `publicFlow: false`: bound into the Workshop, never discovered by the Router, no public route.
- **Workshop bindings and Router HTTP bindings are separate decisions.** A service-only package is
  reachable over vendor RPC, never by a public route.
- **GitHub/Confluence OAuth scopes are per-user.** The upstream packages hold the account
  connection per user; the deployment supplies only the OAuth App's client credentials. Scope
  review stays with the operator's OAuth App registration.
- **`cloudflare` is telemetry/billing observation only.** It never carries infrastructure control;
  governed infrastructure proposals are the P6 `gatekeeper-cloudflare-control` package, a separate
  entry with its own review.
- **MCP endpoints stay explicitly scoped.** The `mcpv2` Worker's SSRF boundary is the package's
  own `global_fetch_strictly_public` flag, preserved by the generator; endpoint scope keys are the
  packages' own (never model-supplied).
- **Portal trust annotations are operator policy.** `MCP_PORTAL_TRUST_ANNOTATIONS` (and every
  other portal variable) is set by the operator in `deployment.jsonc`; the model never supplies
  configuration.
- **Required configuration fails validation loudly.** `mcpPortal` enabled without
  `MCP_PORTAL_URL` refuses the deploy.

Both outer Gatekeepers share the durable action ledger via `packages/stage`
(`@gadgets/stage`): the `staged → pending → approved/rejected` state machine with sequential
durable ids, retire-not-delete rejection, and live+retired proposal lookups. Vendor packages keep
only their policy, error strings, and public proposal mapping.

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
