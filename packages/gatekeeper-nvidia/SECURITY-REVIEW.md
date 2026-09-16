# NVIDIA Gatekeeper — moderate capability security review

Status: Implemented in this starter (`packages/gatekeeper-nvidia`). The deployment generator wires
it when enabled: it emits the Worker config from the package's own `wrangler.jsonc`, adds both
service bindings, and requires the `NVIDIA_API_KEY` secret before wrangler will deploy. The
surface is compute-only — there are no approval-queue write actions, because NVIDIA carries no
vendor write effects; governance is the operator-configured compute allowance enforced in the
account DO before every dispatch.

## Resource scopes

| Scope | Capability | Notes |
| --- | --- | --- |
| Compute account | `listModels`, `describeModel`, `infer`, `embed`, `rerank`, `getBudget` | One `nvidia://` account binding. Models come from the deployment allowlist (`NVIDIA_ALLOWED_MODELS`); empty means nothing runs. The endpoint is operator configuration (`NVIDIA_BASE_URL`, HTTPS only) and is never model-chosen. |

## Authentication and token policy

`NVIDIA_API_KEY` is a per-Worker secret (docs/deployment-secrets.md). It never crosses the RPC
boundary, appears in errors, or enters agent-visible output. Rotate by replacing the secret;
reconnect is intentionally unsupported (`reconnect()`/`commitReconnect()` throw with an explicit
message), preserving account isolation.

## The governed surface

| Operation | Classification | Required control |
| --- | --- | --- |
| `listModels` / `describeModel` / `getBudget` | Read (local) | `authorizeObservation()`; allowlist-derived, no network call. |
| `infer` (text) | Read with external cost/side-effect risk | `authorizeObservation()`, model allowlist, text ceilings (256 KiB UTF-8), `maxOutputTokens` ≤ 8192, output capped at 1 MiB with honest `truncated`, 60 s timeout. |
| `infer` (image parts) | Read with external cost/side-effect risk | Every image is a strictly validated base64 data URI (png/jpeg/webp/gif only), per-part ≤ 256 KiB and ≤ 768 KiB total per request; image content is observation-gated, never executed, never stored beyond bounded evidence. |
| `embed` (text/multimodal) | Read with external cost | Same ceilings; ≤ 96 inputs; embedding vectors verified (numeric, ≤ 8192 dims) and count-matched to the request. |
| `rerank` | Read with external cost | ≤ 100 documents; returned indices verified in-range; vendor response shape verified strictly. |

## Budget governance (the compute allowance)

The account DO enforces an operator-configured finite allowance **before every dispatch**:
`NVIDIA_BUDGET_CALLS` (default 1 000, cap 100 000) and `NVIDIA_BUDGET_TOKENS` (default 2 000 000,
cap 100 M). Actual token usage is settled from the vendor's usage block when reported; calls whose
usage the vendor does not report are settled as calls only, and the missing usage is never
fabricated (cost is `null` in typed usage, never zero). `NVIDIA_CONCURRENCY` (default 2, cap 4)
gates concurrent calls. Exhaustion refuses compute with an explicit, agent-visible error naming
the operator variable to raise deliberately. The task runtime (P4) later adds the stricter shared
task reservation in front of this account ceiling; the provider ceiling remains in force.

## Exclusions (deliberate, per the capability-family taxonomy)

- **Training, weight transfer, batch jobs** — outside this release (end-state spec); the reviewed
  path to revisit is P9.2.
- **GPU provisioning / simulation / optimization tooling** — deferred; each needs its own
  bounded-resource review.
- **Streaming** — requests are non-streaming (`stream: false`) with bounded output; streaming
  responses would need separate bound-while-streaming machinery (Task 1.4's pattern) before
  exposure.
- **Cancellation** — V1 bounds requests by the 60 s timeout; RPC-level caller cancellation does
  not abort in-flight vendor I/O. Documented here as a known boundary.

## Verification notes

Endpoint shapes (`/v1/chat/completions`, `/v1/embeddings`, `/v1/retrieval/reranking`),
authentication, quotas, and pricing must be verified against NVIDIA's current documentation
during integration; the request builders are structured so an endpoint correction is a
policy/config change, not a surface redesign. Pricing is unknown at implementation time: cost is
reported as explicit `null` per the plan's no-fabrication rule.
