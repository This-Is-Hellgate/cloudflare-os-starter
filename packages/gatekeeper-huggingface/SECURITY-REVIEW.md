# Hugging Face Gatekeeper — moderate API security review

Status: Implemented in this starter (`packages/gatekeeper-huggingface`) and listed in the
optional-Gatekeeper catalog (`scripts/deployment-config.ts`). The deployment generator wires it
when enabled: it emits the Worker config from the package's own `wrangler.jsonc`, adds both
service bindings, and requires the `HF_TOKEN` secret before wrangler will deploy. Read surfaces
are live: bounded dataset queries run through the approved `datasets-server.huggingface.co`
backend (fixed dataset, config/split discovery, row/byte limits), and discussion listings return
a real Cap'n Web `RpcTarget` cursor. Writes remain gated in code: `applyAction` executes an
approved action only when the operator sets `HF_ENABLE_WRITES=true|1`; without the gate it
throws. OAuth/token setup and Workshop registration are intentionally not included
until the operator approves this boundary.

## Resource scopes

| Scope | Capability | Notes |
| --- | --- | --- |
| Model repository | Metadata, model card, bounded file listing/text reads, bounded inference | One `models/{namespace}/{repo}` URL and optional fixed revision/provider. Model weights are not streamed through the RPC API. |
| Dataset repository | Metadata, bounded file listing, bounded dataset query | One `datasets/{namespace}/{repo}` URL; config/split and result limits are enforced server-side. |
| Space repository | Metadata, bounded file listing/text reads, pause/resume proposals | One `spaces/{namespace}/{repo}` URL. Space execution/log access is not exposed. |
| Discussions | Bounded listing and proposed comments/discussions | Only for the bound repository; all mutations require approval. |

Resource URLs are parsed and normalized against `huggingface.co` only. Revision values are
allowlisted to a commit SHA or a validated branch/tag name; user-provided URLs cannot select an
arbitrary host, endpoint, organization, or repository outside the binding.

## Authentication and token policy

Use one per-user Hugging Face OAuth or user access-token connection stored only in the User Account
Durable Object. Production connections should use a fine-grained token, separate per application,
with the smallest repository/org permissions needed. Read-only bindings require read access; write
bindings require explicit repository write permission. Inference must be separately enabled and
must not silently expand Hub repository access. Tokens never cross the RPC boundary, appear in
errors, or enter agent-visible model output.

## Read/write inventory

| Operation | Classification | Required control |
| --- | --- | --- |
| Account/resource metadata, model card, dataset/Space info | Read | `authorizeObservation()`, bounded fields, vendor payload treated as untrusted. |
| File list and text read | Read | `authorizeObservation()`, path traversal rejection, byte/page limits; no executable interpretation. |
| Dataset query | Read | `authorizeObservation()`, fixed dataset, config/split resolved via `/splits`, row/byte limits (`maxRows` ≤ 1000, `maxBytes` ≤ 5 MB), whole-row byte enforcement. |
| Dataset page walk (`queryDatasetPages`) | Read | The same verified contract with the same cumulative budgets, filled across server-side offset windows of at most 100 rows (the verified `length` cap of `datasets-server`); every page is an authorized observation, and the walk is bounded by the shared cursor runtime's page budget. |
| Inference | Read with external cost/side-effect risk | `authorizeObservation()` plus per-request budget/rate limit; fixed model/provider and output cap. Provider mode uses the governed `router.huggingface.co/v1/chat/completions` endpoint with reserved keys (`model`, `messages`, `max_tokens`) stripped from user parameters. |
| Discussion listing and detail | Read | `authorizeObservation()`, bounded pages/comments; listing returns a live `RpcTarget` cursor paging the verified Hub contract (response `{discussions, count}`, fixed 50-item pages, `p` offset, `count`-derived exhaustion) rather than a prefetched, capped array. |
| Commit, discussion, comment, Space pause/resume | External write | `submitAction()`; simulate first, then only `applyAction()` after approval. Execution additionally requires the operator gate `HF_ENABLE_WRITES=true|1`. Commits are serialized exactly as the official Hub client does: newline-delimited `header`/`file`/`deletedFile` records with `Content-Type: application/x-ndjson`; the returned `commitOid` is the required receipt and is persisted before success is reported. The stored payload is re-validated before any remote call, and the per-file content hashes bound at approval must still match. |

Write proposals are validated by `src/ndjson.ts` (shared by the session at proposal time and the executor against the stored record): repository paths reject traversal/absolute/NUL forms; V1 carries UTF-8 text add/update and deletion only — binary, lone-surrogate, LFS, and content-bearing deletions are refused, never silently reinterpreted. Revision and parent-commit values are guarded against URL-path traversal; `parentCommit` binds the change to the exact pre-state it builds on. The Hub commit endpoint has no idempotency key: on an uncertain outcome the executor records the attempt as indeterminate and reconciles from the revision's HEAD (parent match ⇒ provably absent; title match ⇒ evidence of application), and only then settles the journal — never a blind retry. Discussion and Space operations must verify the resulting state. Rejection removes any simulated overlay; transient vendor failures are retryable without claiming success.

## Sharing and observer verification

Use tracked sub-resources (strategy C). A session records the repository/revision paths and
discussion records observed by each binding. `addObserver()` must use the observer's own
Hugging Face credentials to check access to every previously observed repository and gated resource.
Return false for a definite 401/403/404; rethrow timeouts and other transient failures. Exclude an
observer from observations whose access cannot be verified. `removeObserver()` is idempotent.

Inference results and gated/private repository content should be marked non-shareable unless the
observer check confirms access to the same model/dataset and the same organization policy. Never
share tokens, private file contents, raw prompts containing credentials, or unbounded vendor output.

## Explicit exclusions and risks

- No account/org admin, token management, billing, endpoint deployment/scaling, job execution, or
  arbitrary Hub API passthrough.
- No arbitrary MCP server URLs. Hugging Face MCP support may be added as a separate, explicitly
  configured resource after endpoint and tool allowlisting; it must not be inferred from a repo URL.
- No unrestricted file download or model-weight transfer through agent RPC.
- No Hugging Face bucket or object-storage access, bucket enumeration, or storage credentials.
- Provider selection is fixed by the connection or an allowlist; arbitrary provider routing is off.
- Webhook support is deferred until signature verification, replay protection, and event scoping are
  designed.

## Sources

- [Hugging Face Hub API endpoints](https://huggingface.co/docs/hub/api)
- [Hugging Face user access tokens](https://huggingface.co/docs/hub/security-tokens)
- [Hugging Face Inference Providers](https://huggingface.co/docs/inference-providers/index)
- [Hugging Face Hub OpenAPI specification](https://huggingface.co/.well-known/openapi.md)
