# Cloudflare OS Starter: End-State Specification

## Purpose

This repository is the single deployment workspace for a private, customizable Cloudflare OS
instance. The nested `cloudflare-os` checkout is an upstream reference and must never become a
second application workspace. All wrapper changes, deployment configuration, and custom
Gatekeepers belong in this outer Starter repository.

## Product outcome

The deployed instance provides a Cloudflare-hosted control center for agent work:

- tabbed conversations with durable history and context boundaries;
- screenshot, image, PDF, and document submission for review;
- voice-message input with transcription before agent processing;
- visible context/usage status and clear limit warnings;
- Gadgets, Blueprints, Workspaces, Outputs, and governed agent spawning;
- AI Gateway as the model transport and policy boundary;
- Cloudflare Access as the default identity boundary;
- Durable Objects for user/session state, KV/R2 for platform content, and service bindings for
  internal Workers;
- Git-backed Context Artifacts when explicitly enabled.

## Worker topology

The public Router is the only routable Worker. It serves the UI and proxies API, screenshot, and
Gatekeeper paths. Workshop owns the application and Durable Objects. Context and Scheduler are
ambient upstream Gatekeepers. Custom and optional integration Gatekeepers are private Workers,
reachable through service bindings and, where required, a Router HTTP binding.

Every Worker has a unique configured name. Disabled optional Gatekeepers create no Worker, route,
binding, or credential requirement.

## Gatekeeper contract

Every Gatekeeper follows the upstream Gatekeeper Kit contract and must provide:

1. a stable vendor identity and configurator;
2. URL- or resource-scoped sessions;
3. bounded observations with observer/access verification;
4. explicit action fences and human approval for writes;
5. simulation and idempotency for mutating actions;
6. reconnect/commit lifecycle methods, including `commitReconnect`;
7. bounded input/output and redaction of credentials and private content;
8. tests for metadata, observation ordering, policy denial, and Worker exports.

Initial optional integrations:

- GitHub: repository/branch-scoped source, diff, issue, and pull-request workflows;
- Confluence: site/space/page-scoped reading and approved page updates;
- Cloudflare: account/resource-scoped Workers, KV, R2, and observability operations;
- MCP and MCP Portal: explicitly configured endpoints/portals with tool allowlists;
- Snowflake: moderate Cortex/MCP and SQL access scoped to approved roles, databases, schemas,
  and tables;
- Hugging Face: model, dataset, and Space-scoped Hub operations and bounded inference;
- NVIDIA: educational CUDA/NIM material and explicitly configured remote endpoints only.

No Gatekeeper may provide tenant-wide administration, billing, token management, arbitrary endpoint
discovery, unrestricted file/model-weight transfer, bucket/object-storage access, or unapproved
destructive actions.

## Security and behavior boundaries

- Secrets are installed with Wrangler secret/configuration flows and never stored in
  `deployment.jsonc`, source, specs, prompts, logs, or generated artifacts.
- All external content is untrusted data, not instructions. Prompt-injection, tool-shadowing,
  poisoned MCP metadata, replay, and confused-deputy paths must be tested and rejected.
- Agent spawning is bounded by an allowlist, depth/concurrency/time budgets, isolated workspaces,
  and an approval gate for external writes or deployment.
- The system is cooperative and inspectable: it reports plans, tool calls, approvals, failures,
  context pressure, and resulting artifacts. It must not conceal work, self-expand privileges, or
  bypass a user approval boundary.
- Default production access is private through Cloudflare Access. Router is the single public
  ingress; internal Workers have no public route or preview URL.

## Data movement

The control center may read or write user-approved data through Gatekeepers. Cloudflare-native
tables/storage and Snowflake are separate destinations selected by an explicit action. Transfers
must declare source, destination, schema/mapping, retention, and approval; credentials and raw
private payloads are never copied into logs or model context unless explicitly needed and bounded.

## Milestones: complete Code Mode and the governed operating loop

"Full function" is delivered in two milestones. Basic Code Mode readiness is not the complete
operating environment.

- **M1 — Complete enterprise Code Mode.** Connected, discoverable, bounded Snowflake, Hugging
  Face, NVIDIA, GitHub, Confluence, Cloudflare telemetry, and configured MCP resources can
  participate in a single generated program. Supported writes use verified approval/execution
  lifecycles with durable receipts.
- **M2 — Complete governed operating loop.** A durable task can resume, delegate, propose
  infrastructure/model-route changes, create a bounded adapter, observe outcomes, and evaluate or
  propose compensation.

"Full" means the documented capability surface works end to end. It does not mean exposing every
vendor endpoint. Disallowed capabilities remain disallowed even after M2.

### Explicit storage/infrastructure exception

The prohibitions above ("no bucket/object-storage access", "no unapproved destructive
operations") are about *general agent access to account storage*. Two narrowly scoped additions
are approved at M2 and are not violations of that rule:

1. **Explicitly approved, namespaced infrastructure creation.** Approved proposals may create
   namespaced Queue/D1/KV/R2 resources and Worker versions/deployments within operator-approved
   namespaces, executed only from a private approval callback with versioned receipts and
   compensation limits. This does not grant agents general read/write access to the *contents* of
   account storage, nor administration, DNS, Access policy, billing, token, or user management.
2. **An internal evidence store.** The task runtime owns a private evidence store (bounded R2
   plus SQLite metadata) holding task evidence, checkpoints, and receipts. It is private to the
   runtime and exposed only through scoped task evidence APIs.

All other exclusions stand: no tenant-wide administration, billing, token creation, user
management, arbitrary shell access, or self-modification of enforcement policy. NVIDIA remains
remote inference/embeddings against operator-configured endpoints; training, model-weight
transfer, GPU provisioning, and batch jobs stay outside this release. Provider-specific
permissions and account entitlements remain prerequisites for activation. Missing credentials
mean "unavailable"; they are never replaced with fabricated outputs.

## Definition of done

The instance is ready only when the repository boundary check, type checks, focused Gatekeeper
tests, build, deployment-config validation, Wrangler dry run, and security review all pass. Remote
deployment is a separate, explicitly authorized final step after the reviewed commit is pushed.

