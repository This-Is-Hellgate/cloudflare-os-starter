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

## Definition of done

The instance is ready only when the repository boundary check, type checks, focused Gatekeeper
tests, build, deployment-config validation, Wrangler dry run, and security review all pass. Remote
deployment is a separate, explicitly authorized final step after the reviewed commit is pushed.

