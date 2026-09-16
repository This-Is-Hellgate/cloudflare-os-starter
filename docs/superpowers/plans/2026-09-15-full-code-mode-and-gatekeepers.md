# Full Code Mode and Gatekeeper Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` to execute approved packets task by task. Subagent execution is an alternative only when requested. Checkboxes track implementation evidence, not permission.
>
> **Document status:** Implementation program prepared from the repository survey on September 15, 2026. Creating this document does not start implementation or authorize deployment. Platform integration gates below must be demonstrated before the dependent capability can be enabled.

**Goal:** Deliver an operating environment in which Code Mode composes approved enterprise capabilities, performs governed writes, persists and resumes objectives, delegates narrower work, builds bounded executable adapters, and evaluates the effects of its actions.

**Architecture:** Retain the pinned Workshop kernel and its Code Mode executor, resource bindings, approval queues, persistent callbacks, and agent spawner. Extend the outer repository with provider Gatekeepers, a durable task runtime, enforced task capabilities, and a private capability factory. Keep authority enforcement and vendor credentials outside model-authored code.

**Tech stack:** Cloudflare Workers, Workers RPC and the pinned Cap'n Web contracts, SQLite-backed Durable Objects, Scheduler, Workers for Platforms, TypeScript, Node `>=24.19.0`, pnpm `11.17.0`, existing workspace catalogs and lockfiles.

**Spec inputs:** `docs/cloudflare-os-end-state-spec.md`; the September 14 capability-escalation proposal at `C:/Users/mchay/Downloads/cloudflare_os_capability_escalation_implementation_plan.md`; the September 15 repository survey in this task. This plan contains the decisions needed to implement the expansion without depending on access to the Downloads file.

## 1. Scope and definition of full function

Two milestones prevent basic Code Mode readiness from being confused with the complete operating environment.

| Milestone | Required result | Packets |
|---|---|---|
| M1: Complete enterprise Code Mode | Connected, discoverable, bounded Snowflake, Hugging Face, NVIDIA, GitHub, Confluence, Cloudflare telemetry, and configured MCP resources can participate in a single generated program. Supported writes use verified approval/execution lifecycles. | P0–P3 |
| M2: Complete governed operating loop | A durable task can resume, delegate, propose infrastructure/model-route changes, create a bounded adapter, observe outcomes, and evaluate or propose compensation. | P4–P8 |

“Full” means the documented capability surface works end to end. It does not mean exposing every vendor endpoint. Disallowed capabilities remain disallowed even after M2.

### Scope reconciliation

The existing end-state specification prohibits general bucket/object access and unapproved destructive operations. This program adds **explicitly approved, namespaced infrastructure creation** and an **internal evidence store** at M2. It does not add general agent access to account storage contents. NVIDIA V1 remains remote inference/embeddings against operator-configured endpoints; training, model-weight transfer, GPU provisioning, and batch jobs are outside this release.

P0 updates the end-state specification to describe these distinctions before implementation expands authority. Provider-specific permissions and account entitlements remain prerequisites for activation. Missing credentials mean “unavailable”; they must never be replaced with fabricated outputs.

### Global constraints

- Preserve `cloudflare-os/` as a clean upstream gitlink. Custom implementation belongs in outer `packages/`, `scripts/`, `docs/`, and source deployment configuration.
- Preserve Node `>=24.19.0`, pnpm `11.17.0`, workspace dependency policy, and compatibility between the inner and outer RPC runtimes.
- Add dependencies only for required functionality; resolve through the existing catalog/lockfile policy. Do not introduce optional dependency branches.
- Router remains the only public ingress. A private control Worker has no workers.dev, preview URL, custom route, or Router HTTP binding.
- Preserve upstream account, observer, resource, reconnect, approval, and hook semantics. An admin-enabled Worker is not automatically an agent-accessible account.
- No raw vendor tokens, arbitrary authenticated HTTP proxy, model-chosen credentials, or model-granted permissions.
- Reads and computation are bounded and authorized; computation can incur cost and must consume budgets.
- Every write requires an explicit approval or a narrowly defined, recorded preauthorization. A deployment-wide “writes enabled” flag alone is not approval.
- No external exactly-once guarantee without a vendor protocol that supports it. Ambiguous execution is a durable state requiring reconciliation.
- Generated `wrangler.prod.jsonc` files remain ephemeral. Source configuration is authoritative.
- No unrestricted administration, DNS, Access policy changes, billing changes, token creation, user management, arbitrary shell access, or self-modification of enforcement policy.
- **No test soup:** extend existing suites, test observable invariants, and use a small shared integration suite. Do not generate one test file per class, method, interface, or provider response field.

## 2. Verified starting point

| Item | Survey evidence |
|---|---|
| Outer checkout | `ff8fb79d4ba34dd59180e8fe4cb82b71f83f11ff`, branch `main` |

> **Kernel bump (September 15):** the submodule pin moved `45ae8c21` → `0272b060` (14 upstream commits). Load-bearing changes: `spawnCallable(title, {types, mainType})` returns a `CallableAgent` whose calls resolve once durably queued, accepts persistent callback stubs, and spawned agents persist across restarts (upstream design: `cloudflare-os/plans/spawner-with-persistence.md`); Scheduler `ctx.restore()` is now valid inside the Gadget; `getAgentCatalog()` lost its authorizer parameter and is delivered every turn as non-observation metadata; `packages/integration-tests` exports the real-Workshop harness (Task 3.2 consumes it); `packages/gatekeeper-kit` is upstream's shared gatekeeper machinery; `plans/gatekeeper-kit.md` and `plans/evals-and-e2e-tests.md` are upstream design inputs. The Workshop's model layer is pi-agent-core/pi-ai (exact-pinned; migration playbook `plans/pi-impl.md`, completed upstream in `bdb6dc75` before our original pin): all inference is HTTPS-with-tokens (AI Gateway via token, BYOK via the unified `/compat` endpoint), the `WORKERS_AI` binding remains only for webFetch and gateway log-cost, and the overseer's turn lifecycle — including `awaitDecision` suspension, which our Stage approval flow depends on — is a preserved invariant.
| Original proposal baseline | `dcc64f2a7e036258a59e7807757b17b86d34a880`; object unavailable locally; ancestry/diff not established |
| Inner checkout | Clean at `45ae8c21b4b6b30ca81f69fc1f65db1f42a89278` |
| Existing outer packages | `cursor`, `stage`, `custom-gatekeeper`, `error-reporter`, `gatekeeper-snowflake`, `gatekeeper-huggingface` |
| Optional deployment wiring | Snowflake and Hugging Face; other catalog entries are not wired |
| Core capabilities | Context and Scheduler already deployed; Workshop already supports Code Mode and restricted callable agents |
| Verification | Root test passed: 134 tests total. Root check passed, including build/dry runs. Root lint failed: 7 errors, 2 warnings. Inner full test suite was not run. |
| Toolchain | Node 24.19.0; pnpm 11.17.0; dry runs resolved outer Wrangler 4.130.0 and inner 4.128.0 |
| CI | No outer `.github/workflows/` directory was present; remote CI status was not verified |
| User changes | `deployment.jsonc` locally enables Snowflake; `.deploy-log.txt` is an empty untracked file |

Preserve the user's deployment changes and files. The tracked root file named `-` is an unrelated cleanup candidate and is excluded from this implementation.

### Existing contracts to reuse

- `cloudflare-os/packages/workshop-backend/src/agent.ts`: `executeCode` accepts a JavaScript module exporting `default async function(self, env, ctx)`. File tools take a `workpieceId` (multi-gadget). The step barrier (`STEP_CHANGE_BUDGET`, plans/step-transactionality.md) commits a step's tool-call record and its content effects in one transaction; `executeCode` after buffered edits throws a retryable "changes land next step" error.
- `cloudflare-os/packages/workshop-backend/src/overseer.ts`: multi-gadget workspaces (plans/multi-gadget.md, landed in `e8132b07`): shared workpiece ID namespace, per-workpiece Yjs roots and facets, binding edges per gadget, `createGadget`, `defaultGadgetId` resolution, schema-version migration on every entrypoint. Constructs named bindings and runs isolated Code Mode with `globalOutbound: null`.
- `cloudflare-os/packages/workshop-backend/src/agent-spawner-binding.d.ts`: `spawn(title, prompt): Promise<void>` and `spawnCallable(title, {types, mainType}): Promise<CallableAgent>` — typed interface declarations, calls resolving once durably queued, persistent callback stubs passable as arguments, agents persistent across restarts (plans/spawner-with-persistence.md).
- `cloudflare-os/packages/gatekeeper-scheduler/src/types.d.ts`: `runAt`, `every`, `calendarAt`, `list`; persistent hooks use `ctx.restore()` — valid inside the Gadget itself as well as from `executeCode` (upstream #492 relaxed the facet-stub restriction). Registration needs user enablement in Connections; `list()` only shows enabled schedules. There is no session `cancel()` method to assume.
- `cloudflare-os/packages/workshop-shared/src/gatekeeper.ts`: Gatekeeper session, observer, approval queue, and hook contracts. `getAgentCatalog()` is OPTIONAL unverified discovery metadata delivered into every chat's prompt every turn (no authorizer parameter, not an observation); most gatekeepers omit it. It is not a universal method registry.
- `cloudflare-os/packages/gatekeeper-github/` and `gatekeeper-confluence/`: existing write staging and simulation remain authoritative; do not migrate them into outer Stage merely to standardize storage.
- `packages/cursor/src/cursor.ts`: existing bounded live pagination; reuse it where its contract fits.

Line references in the previous survey are navigation aids. Implementation must read the current symbols and applicable `AGENTS.md` before editing.

## 3. Target topology and authority ownership

```text
Browser -> Router -> Workshop
                       |
                       +-> native accounts/resources and existing approval queues
                       +-> Code Mode: named capability bindings, no direct network
                       +-> configured callable agent profiles

Governed callable agent
  -> task-scoped typed capability facade
      -> task grant/budget reservation
      -> provider session (observer + resource checks)
      -> provider API

Proposal -> owning Gatekeeper's approval queue -> private apply callback
          -> immutable action + execution attempt -> vendor -> receipt/reconciliation

Scheduler -> restored coordinator hook -> durable run admission -> callable agent
Task runtime -> evidence/checkpoints/action references/child results/evaluations
Factory -> private dispatch namespace -> bounded generated adapter
```

The task runtime stores task policy and continuity; it has no vendor secrets. Each provider owns vendor permissions, its account connection, and the actual execution boundary. The Stage package supplies reusable lifecycle logic but is **not one account-wide approval database**. Action references always include their owning account/Gatekeeper scope.

Governed agent profiles receive typed task facades rather than direct provider bindings. Ordinary Workshop chats may retain their native capabilities, but must not be described as constrained by task budgets unless they are running through the governed profile.

## 4. Common contracts

These are proposed internal contracts, not claims that the pinned upstream APIs already implement them. Implement them in the files named below, deriving upstream-facing types from upstream exports. Do not mirror upstream RPC interfaces through casts.

### 4.1 Action identity, approval, and execution

Owner: `packages/stage/src/contracts.ts`.

```ts
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type ActionRef = {
  gatekeeperId: string;
  accountId: string;
  actionId: number;
};
export type ApprovalSubject = {
  ownerId: string;
  workspaceId: string;
  taskId: string | null;
  operation: string;
  resource: string;
  payloadHash: string;
  policyVersion: string;
  expiresAt: number;
};
export type Decision = "staged" | "pending" | "approved" | "rejected" | "expired";
export type ExecutionStatus =
  "not-started" | "executing" | "succeeded" | "failed" | "indeterminate" | "partial";
export type Receipt = {
  ref: ActionRef;
  subject: ApprovalSubject;
  attempt: number;
  requestId: string;
  vendorId: string | null;
  version: string | null;
  beforeHash: string | null;
  afterHash: string | null;
  resultHash: string;
  recordedAt: number;
  evidenceIds: string[];
};
export type ExecutionAttempt = {
  ref: ActionRef;
  number: number;
  idempotencyKey: string;
  leaseEpoch: number;
  status: ExecutionStatus;
  receipt: Receipt | null;
  errorCode: string | null;
};
```

IDs/subject fields come from trusted session/account context, not model claims. Use the vendor's real request/commit/statement/version identifier when available. If unavailable, `vendorId` stays null and the receipt must carry a bounded read-back evidence reference; a local random ID must not masquerade as a vendor receipt.

Decision transitions are `staged -> pending -> approved|rejected|expired`, with rejection/expiration also allowed before submission completes. Terminal decisions cannot be revived. Execution is separate; approved does not mean successfully applied.

Persist the immutable normalized payload and digest before approval submission. Persist the attempt/key before I/O. The owning DO must claim attempts atomically using its real transaction/storage semantics. Do not implement concurrency guarantees using several awaited calls on the current generic KV interface.

On restart, an unfinished attempt becomes indeterminate. Query the vendor by idempotency/request/version key or reconcile exact state before retry. A failed attempt is retryable only when absence of an external effect is established. Leases fence local completion; they cannot undo a request already sent to a vendor.

### 4.2 Task grants and budgets

Owner: `packages/gatekeeper-task-runtime/src/contracts.ts`.

```ts
export type Grant = {
  id: string;
  ownerId: string;
  workspaceId: string;
  taskId: string;
  binding: string;
  resource: string;
  methods: string[];
  policyVersion: string;
  expiresAt: number;
  maxCalls: number;
  maxWrites: number;
  maxCostMicrousd: number;
};
export type Reservation = {
  id: string;
  runId: string;
  grantId: string;
  epoch: number;
  reservedCostMicrousd: number;
};
export type RunAdmission = {
  runId: string;
  epoch: number;
  disposition: "admitted" | "duplicate" | "denied";
};
export type ChildResult = {
  childTaskId: string;
  status: "completed" | "failed" | "cancelled";
  summary: string;
  evidenceIds: string[];
  actionRefs: import("../../stage/src/contracts.js").ActionRef[];
};
```

Publish cross-package types through explicit package exports in implementation; the relative import above identifies the source owner. Facades expose explicit provider methods, not `call(binding, arbitraryMethod, args)`. Grants are installed by authenticated owner/admin configuration. Sessions cannot edit them.

Each facade reserves calls, writes, and a conservative maximum compute cost before dispatch. Settle actual usage afterward; retain reservation during ambiguous outcomes. Child reservations come out of the parent's remaining budget. Aggregate concurrent reservations must not exceed the parent limit. Missing trustworthy price/usage data disables automatic spend decisions for that model.

### 4.3 Evidence, continuation, and results

Store metadata in SQLite tables: `tasks`, `grant_versions`, `runs`, `reservations`, `evidence`, `checkpoints`, `action_links`, `schedules`, `children`, `experiments`, `audit_events`. Each table includes owning task/account scope and schema version where required. Use explicit indexes for `(task_id, created_at)` and unique logical run/event keys.

Evidence distinguishes a verified provider observation from an agent claim. Store origin, resource, observation time, content hash, and observer provenance. Model-authored evidence cannot become a trusted receipt or evaluation by choosing its `kind` field. Large content goes to a private evidence R2 binding owned by the runtime; only scoped evidence APIs expose it.

Task statuses: `active`, `waiting`, `waiting-approval`, `evaluating`, `completed`, `failed`, `cancelled`. A completion requires satisfied acceptance criteria or an explicit owner override recorded as such. A model cannot certify its own result by submitting a score.

Use stable logical run keys derived from task ID plus Scheduler occurrence/callback event ID. Exactly one durable admission per logical key is the goal; delivery and external effects remain retryable and independently reconciled.

## 5. Packet sequence

| Packet | Deliverable | Dependencies | Activation |
|---|---|---|---|
| P0 | Reconciled spec, supported baseline, working release checks | None | No expanded authority |
| P1 | Correct provider writes, execution recovery, byte bounds, bootstrap | P0 | Existing writes only after gate passes |
| P2 | Existing upstream connectors wired and provisioned | P1 | Individual resources enabled explicitly |
| P3 | NVIDIA and demonstrated M1 composition | P2 | Bounded compute |
| P4 | Enforced task runtime and persistent continuation | P1–P3 | Task profiles after persistence proof |
| P5 | Narrow child agents and durable result collection | P4 | Profile/depth/budget limits |
| P6 | Cloudflare/AI Gateway control, audit, compensation | P4 | Per-operation approval policy |
| P7 | Isolated capability factory | P4, P6 | Preauthorized ephemeral policy; promotion approved |
| P8 | Evaluation loop, model tournament, M2 acceptance | P5–P7 | Bounded experiments; rollout approval |

Implement each task as one coherent review unit, with its documentation and relevant check. Do not combine all packets into a single implementation branch. Parallelism is optional; dependencies above are mandatory.

## P0 — Reconcile the baseline and release contract

### Task 0.1: Record reproducible state and reconcile specification

**Modify:** `docs/cloudflare-os-end-state-spec.md`, `README.md`.
**Create:** `docs/implementation-baseline.md`.
**Read:** `package.json`, `pnpm-workspace.yaml`, both lockfiles, `.gitmodules`, `scripts/boundary-check.ts`, inner `AGENTS.md`.

- [ ] Record HEAD, gitlink, dirty paths, package versions, enabled Gatekeepers, lockfile hashes, and exact commands/results. Establish the original baseline only if the actual object can be retrieved and compared; do not assume it is an ancestor.
- [ ] Add M1/M2 scope and the explicit storage/infrastructure exception described in section 1 to the end-state spec. Preserve the excluded operations.
- [ ] Record supported CI environments as Windows and Linux. Preserve the inner lockfile; document intentional toolchain divergence or align only the outer toolchain after compatibility checks.

```powershell
git rev-parse HEAD
git submodule status
git status --short
node --version
pnpm --version
pnpm exec wrangler --version
```

**Acceptance:** the implementation target can be reproduced without the conversation or Downloads file.

### Task 0.2: Repair existing release checks

**Modify:** `packages/stage/__tests__/stage.test.ts`, `packages/stage/__tests__/gated.test.ts`, `packages/gatekeeper-snowflake/src/snowflake.ts`, `packages/gatekeeper-snowflake/__tests__/sql-pages.test.ts` for the reported lint failures; `scripts/deploy.test.ts` and `packages/cursor/__tests__/cursor.test.ts` only if resolving the reported warnings.
**Create:** `.github/workflows/ci.yml`.

- [ ] Replace inappropriate mutating test/helper sorts with `toSorted()` and remove genuinely unused imports/variables. Do not restructure provider code as lint cleanup.
- [ ] Configure `ubuntu-latest` and `windows-latest`, recursive submodule checkout, Node 24.19.0 and pnpm 11.17.0, frozen installs for both workspace roots, and root `pnpm test`, `pnpm lint`, `pnpm check`.
- [ ] Use a non-secret deployment fixture in CI; add `--config <path>` support to `scripts/deploy.ts` if needed so CI never depends on a user's deployment settings. Validate the chosen path explicitly.
- [ ] Keep CI without vendor credentials and remote deployments. Dry runs verify bundling/configuration, not live permissions.

**Acceptance:** existing checks pass in both environments. No extra tests are needed for unused-import or sort cleanup.

## P1 — Repair authority before adding capabilities

### Task 1.1: Approval integrity, execution journal, and legacy migration

**Modify:** `packages/stage/src/stage.ts`, `packages/stage/src/gated.ts`, `packages/stage/src/index.ts`, `packages/stage/README.md`, both provider DO integrations.
**Create:** `packages/stage/src/contracts.ts`, `packages/stage/src/execution.ts`.
**Tests:** extend `packages/stage/__tests__/stage.test.ts` and `gated.test.ts`; add the real DO race/restart case to the shared integration suite in P3.

Create the minimal shared integration package and persistence fixture listed in Task 3.2 **during this task**, so P1's recovery gate is executable before P2 begins. P3 expands that same harness to Workshop composition; it does not create a second harness. Add only the package configuration, harness, and mutation scenario required at this point.

- [x] Implement separate decision/execution records from section 4.1. Keep upstream action IDs numeric and preserve account scoping.
- [x] Make private queue-driven `apply()` the only approval execution entry. Remove staged-to-executed shortcuts and refuse expired/rejected/foreign actions before vendor I/O.
- [x] Make queue submission safe when an auto-approved callback arrives before `submitAction()` returns. Persist a submission intent and pending state first; if delivery outcome is unknown, retain and reconcile it rather than deleting an action the queue may own.
- [x] Bind exact normalized payload hash, owner, account, workspace, policy version, and expiry. Recheck scope and current policy at execution time.
- [x] Treat invocation through the owning upstream approval capability as the trusted decision signal; possession of an action ID or an editable `approved` field is insufficient. Preserve approval identity and provenance in the journal. Supply no model-visible method that manufactures that signal.
- [x] Add atomic attempt claims in the owning DO, immutable attempts, durable receipts, and indeterminate recovery. Never mark approved as a synonym for success.
- [x] Migrate old rejected records to terminal rejected; old approved records to historical success with `legacy-receipt-unavailable` provenance, without fabricating vendor receipts or reexecuting. Require resubmission of legacy open proposals lacking approval hashes. If live/retired duplicates conflict, quarantine for operator reconciliation.

**Focused verification:** one table-driven terminal transition regression and one execution scenario containing replay, race, and crash-after-vendor-success checkpoints. Assert vendor invocation count and durable outcome, not private helper calls.

```ts
// Integration fixture contract to implement in the shared harness:
// approveAndApply(ref), restartOwner(), reconcile(ref), vendorWrites(), status(ref).
await h.approveAndApply(ref); // inject crash after vendor accepted the write
await h.restartOwner();
await h.reconcile(ref);
expect(await h.vendorWrites()).toBe(1);
expect(await h.status(ref)).toBe("succeeded");
```

**Acceptance:** no terminal resurrection, no duplicate dispatch from concurrent callers, and no blind retry after an uncertain effect.

### Task 1.2: Correct Hugging Face writes and receipts

**Modify:** `packages/gatekeeper-huggingface/src/huggingface.ts`, `types.d.ts`, `types-code.ts`, `SECURITY-REVIEW.md`; existing `__tests__/actions.test.ts`.

- [x] Serialize Hub commits as newline-delimited header/file/deletedFile records according to the official Hub implementation; send `application/x-ndjson`.
- [x] V1 permits UTF-8 text additions/updates and file deletion only. Encode text as required by the Hub file record; reject binary/LFS operations, path traversal, empty changes, and malformed revisions.
- [x] Bind the repository, revision, parent commit, paths, and content hashes to approval. Require returned commit OID; persist it before reporting success.
- [x] On timeout after submission, reconcile using the parent/expected commit/tree metadata. Do not assume the endpoint has an idempotency key; uncertain results remain indeterminate.

**Focused verification:** one official-protocol fixture through the real request serializer, including Unicode content, deletion, parent commit, and OID extraction. Extend the existing denial case for unsupported payloads.

**Acceptance:** a separately authorized sandbox commit can be read back at its returned OID; replay cannot create an unreviewed extra commit.

### Task 1.3: Bind Snowflake SQL to authorized objects

> **Amendment (September 15, user-approved):** capability maximized with governance. The model
> keeps SQL as its input dialect; a parse-or-refuse adapter compiles it to the structured plan
> that is approved and journaled. The grammar is widened rather than the surface freed: a
> governed DELETE variant, expression atoms with an operator-configured function allowlist
> (including CAST and CASE), subquery-fed inserts materialized through the read role, ordered
> multi-step plans, and operator-installed preauthorization patterns for routine writes. A
> separate operator-authored SQL path (never model-proposable) keeps one-off ad-hoc fixes
> available to the organization while model authority stays bounded. DDL remains excluded
> (P6 governed infrastructure plane).

**Modify:** `packages/gatekeeper-snowflake/src/policy.ts`, `snowflake.ts`, `types.d.ts`, `types-code.ts`, `env.d.ts`, `SECURITY-REVIEW.md`; existing policy/actions suites.
**Create:** `packages/gatekeeper-snowflake/src/write-plan.ts`.

- [x] Replace public free-form write SQL with `insert`, `update`, and `merge` structured proposals. Reject the old SQL-write interface with a migration message; do not silently reinterpret it.
- [x] Qualified tables contain exactly database/schema/table components. Quote identifiers using Snowflake rules; bind scalar values. Build merge sources from bounded structured rows/columns, not SQL fragments. Predicate nodes permit comparisons, null checks, and bounded AND/OR groups; deny expressions, functions, subqueries, and empty update predicates.
- [x] Implement discriminated mutation variants with operation-specific required fields; generated SQL alone is executable. Store its hash and bindings hash in the approved payload.
- [x] Force configured read/write roles and warehouse. The read role's vendor RBAC limits objects for free-form read SQL; the statement-class guard is not object authorization.
- [x] For writes, persist a stable SQL API request identifier and statement handle; reconcile documented retry/result semantics before reissuing. Deny multi-statement requests and unapproved object creation.
- [x] Bound affected rows where enforceable; otherwise label estimates and require narrower predicates/explicit owner approval. Do not promise a preflight SELECT guarantees the later affected row count.

**Focused verification:** extend the existing policy regression to demonstrate that allowlisted table A cannot be paired with SQL for table B; cover structured compilation and bound values in the same fixture. Extend the read request case to prove role/warehouse are operator-selected.

**Acceptance:** actual write target equals approved target; reads cannot choose another warehouse or role; vendor request receipt survives a retry.

### Task 1.4: Correct output limits and first-deploy secrets

**Modify:** bounded readers/outputs in both provider packages and `sql-pages.ts`; `scripts/deployment-config.ts`, `scripts/deploy.ts`, `scripts/deploy.test.ts`, `README.md`.
**Create:** `scripts/deployment-secrets.ts`, `docs/deployment-secrets.md`.

- [x] Use `TextEncoder().encode(value).byteLength` for UTF-8 limits. Keep tiny local helpers unless a real shared abstraction is needed. Bound response streams while reading; checking size after buffering an unbounded body is insufficient.
- [x] Enforce total page/output budgets across cursor calls; dispose cursors and release resources at exhaustion, timeout, and cancellation.
- [x] Add per-Worker secret contracts, including separate Snowflake read/write credentials when write authority is enabled. Existing read credentials may migrate only after their scope is checked.
- [x] Read secrets from operator-supplied secure sources, build one temporary file per target Worker outside the repo, restrict ACL/mode, use the actual installed Wrangler first-deploy secret-file option, and remove files in `finally`. Do not pass secrets through shell argument interpolation or combine provider credentials.
- [x] Dry-run mode uses contract validation without loading real secrets. Real bootstrap must fail before deployment when ACL restriction or contract completeness fails. Document manual cleanup after process termination.

**Focused verification:** one Unicode output-boundary regression per distinct implementation path, plus one bootstrap isolation/failure-cleanup test in the existing deploy suite. No test per secret name.

**Acceptance:** declared byte ceilings hold and first deployment receives only the target Worker's credentials.

## P2 — Wire and provision existing Gatekeepers

### Task 2.1: Explicit service graph and secret/config contracts

**Modify:** `scripts/deployment-config.ts`, `scripts/deploy.ts`, `scripts/deploy.test.ts`, `deployment.jsonc`, `docs/gatekeeper-catalog.md`, `README.md`.

- [x] Extend catalog metadata with `publicFlow: boolean`, optional Router prefix, configuration schema, secret contract, and package entrypoint. Workshop service bindings and Router HTTP bindings are separate decisions.
- [x] Wire `github`, `confluence`, `cloudflare`, `mcp`, and `mcpPortal` from their actual upstream Wrangler/deploy-inputs contracts; retain each package's required bindings, DO migrations, and compatibility flags.
- [x] Keep the user's Snowflake setting intact. New entries default disabled. An enabled unsupported/incomplete contract fails generation.
- [x] Preserve GitHub/Confluence OAuth per-user account scopes. Cloudflare here remains telemetry/billing integration, not infrastructure control. MCP endpoints stay explicitly scoped; portal trust annotations are operator policy, never accepted from model input.
- [x] Keep control/runtime/factory Workers out of Router discovery entirely. Their eventual catalog records use `publicFlow: false`.

**Focused verification:** extend the existing generated-service-graph test as a data-driven catalog fixture. Assert enabled/disabled behavior, exact secret ownership, and no Router binding for service-only packages.

### Task 2.2: Connection, resource binding, and Code Mode discoverability

**Create:** `docs/code-mode-operator-guide.md`.
**Modify:** outer provider session/type/catalog code only for demonstrated contract gaps; `docs/gatekeeper-catalog.md`.

- [x] Document the complete chain: deploy Worker -> enable vendor -> connect/provision account -> authorize resource -> bind resource to workspace/chat -> read generated TypeScript session catalog -> execute Code Mode.
- [x] Exercise metadata, `startSession`, observer verification, action simulation, reconnect/credential commit, and account revocation against the pinned contract. Static-token providers must define unsupported reconnect behavior explicitly and preserve account isolation; never simulate successful OAuth.
- [x] Use stable suggested names: `SNOWFLAKE`, `HUGGINGFACE`, `NVIDIA`, `GITHUB`, `CONFLUENCE`, `CLOUDFLARE_OBSERVABILITY`, `SCHEDULER`. These are operator binding conventions, not automatic env injection.
- [x] Keep optional `getAgentCatalog` as discovery metadata. Generated session types are the method contract. Ensure `types-code.ts` and `types.d.ts` agree through the existing generation/check pattern.
- [x] Document that buffered gadget edits require a later agent step before Code Mode execution; never promise a new deployment binding appears halfway through an existing execution.

**Acceptance:** connected resources appear in the actual model-visible catalog and are callable together, including after reconnect; revoked access fails before provider data is returned.

## P3 — NVIDIA and enterprise composition

### Task 3.1: Bounded NVIDIA compute Gatekeeper

**Create package:** `packages/gatekeeper-nvidia/` with `package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `wrangler.jsonc`, `SECURITY-REVIEW.md`; `src/index.ts`, `nvidia.ts`, `policy.ts`, `types.d.ts`, `types-code.ts`, `env.d.ts`.
**Modify:** deployment catalog/generator/docs.

- [ ] Follow the existing Gatekeeper account/resource/session pattern. Obtain models from a deployment allowlist, not arbitrary endpoint discovery.
- [ ] Expose `listModels`, `describeModel`, `infer`, and `embed`. Use typed text/chat inference and string-array embedding inputs; reject arbitrary URL, header, or provider JSON passthrough.
- [ ] Credential is `NVIDIA_API_KEY`; endpoint and allowed models are operator configuration. Default inference timeout 60 seconds, input 256 KiB UTF-8, output 1 MiB, 2 concurrent calls per account, and 8,192 maximum output tokens subject to stricter model limits.
- [ ] Reserve compute budget, honor cancellation, bound streaming responses, and return typed usage with unknown cost represented explicitly.

Before P4, enforce compute reservations in the NVIDIA account DO using an operator-configured finite spend/call allowance. P4 adds the stricter shared task reservation in front of this account ceiling; the provider ceiling remains in force. This avoids making P3 depend on the later task runtime.

**Focused verification:** one provider-session scenario covering authorization before network, allowed inference, and a denied model/oversized response. Reuse its adapter fixture in the integration suite.

### Task 3.2: One shared integration harness and M1 proof

**Extend the package introduced in Task 1.1:** `packages/operating-environment-tests/package.json`, `vite.config.ts`, `vitest.config.ts`, `src/harness.ts`, `src/composition.test.ts`.

- [ ] Build a workerd/Worker integration harness that uses real outer Gatekeeper/session implementations, real Stage storage, and controlled vendor HTTP fixtures. Reuse pinned upstream test utilities only through supported exports; do not copy their full harness.
- [ ] Define fixture operations used in Task 1.1: `approveAndApply`, `restartOwner`, `reconcile`, `vendorWrites`, `status`. The fixture must actually interrupt/recreate the owning DO; an in-memory map is insufficient proof of persistence.
- [ ] Run one generated Code Mode program through the actual Workshop binding path: Snowflake pages -> model inference -> GitHub or Confluence evidence. Use real provider contracts and count successful domain calls. Do not pass handcrafted fake env objects as the final proof.
- [ ] Extend that same scenario with an approved write/read-back and rejected-write denial. Store the resulting execution trace/receipt as acceptance evidence, with sensitive content redacted.
- [ ] Add a separate operator-run live mode requiring explicit fixture account/resource configuration. No remote writes run in ordinary CI.

**M1 gate:** catalogs, composition, observer checks, supported writes, reconnect/revocation, root checks, and one authorized live sandbox workflow pass. A mock-only success does not establish vendor readiness.

## P4 — Persistent tasks with enforced capabilities

### Task 4.1: Prove the upstream integration seam

**Create:** `docs/task-runtime-integration.md`; extend the shared integration harness.
**Read:** upstream Gatekeeper hooks, `agent-spawner-binding.d.ts`, `overseer.ts`, Scheduler types and README.

- [ ] Demonstrate an outer-owned trusted coordinator gadget using persistent restored hooks and a configured `spawnCallable` agent. Store and invoke its callable after owner DO restart using the exact RPC substrate supported at that boundary.
- [ ] Demonstrate a provider session retained/restored by a trusted coordinator without exposing it to the child's env. The child's only enterprise entry is a typed task facade. Confirm metadata preserves account/observer authorization.
- [ ] Demonstrate Scheduler delivery into that coordinator after the user enables its hook. Persist the registration ID immediately; absence from `list()` before enablement is expected.
- [ ] Confirm cancellation management through the actual upstream Connections/hook controller. Do not invent a Scheduler session cancellation API.

**Decision rule:** if any of these cannot be represented using pinned public contracts, stop only the dependent P4–P8 work, record the exact missing upstream API and required compatibility change, and propose a separately reviewed upstream commit/gitlink bump. M1 remains independently deliverable. Do not build against a fictional continuation endpoint or permanent local kernel patch.

### Task 4.2: Task storage, provenance, and operator controls

**Create package:** `packages/gatekeeper-task-runtime/` with the normal Worker/package/type configuration and `SECURITY-REVIEW.md`.
**Create source:** `src/index.ts`, `task-gatekeeper.ts`, `governed-task-do.ts`, `contracts.ts`, `storage.ts`, `evidence.ts`, `authority.ts`, `task-session.ts`, `types.d.ts`, `types-code.ts`, `env.d.ts`.
**Create trusted coordinator source:** `packages/task-coordinator/src/coordinator.ts`, `facades.ts`, `restore.ts`, `profiles.ts`, `package.json`, `tsconfig.json`, `vite.config.ts`. Package as a versioned installable gadget artifact using the existing gadget format; it is not a separate public Worker.

- [ ] Implement SQLite tables described in section 4.3 with forward migrations and explicit schema versions. Keep immutable authority history and bounded private evidence storage.
- [ ] Expose task-scoped `get`, `appendClaim`, `listEvidence`, `checkpoint`, `listActions`, `requestCompletion`, `fail`, and `listChildren`; receipt/verified observation/evaluation writes use trusted internal paths.
- [ ] Initial task limits: 24-hour lifetime, 100 runs, 4 concurrent child tasks, depth 2, 64 KiB checkpoints, 1 MiB individual evidence objects, 100 MiB total evidence. Owner configuration may lower them; raising limits is an authenticated policy change.
- [ ] Owner/admin surface supplies create, cancel, pause, resume, policy install, and audit export. Mount management through existing Workshop Gatekeeper UI conventions; keep runtime Worker service-only.
- [ ] Sign/version the installed coordinator artifact in owner-controlled configuration and reject edited or unregistered coordinator versions when minting task capabilities. A gadget wrapper alone is not a trust boundary if its author can change its code and regain direct provider bindings; final authority checks remain in provider/runtime Workers.
- [ ] Cancellation advances the task epoch, denies new dispatch, cancels local queued work, and records in-flight vendor operations for reconciliation. It must not claim already accepted writes were cancelled.
- [ ] Document data retention: default 30 days for evidence, 90 days for redacted audit metadata, legal/owner holds and deletion through authenticated management. Purging content leaves explicit unavailable-evidence markers, not broken silent references.

### Task 4.3: Typed grant enforcement and durable continuation

**Modify:** task-runtime `authority.ts`, `governed-task-do.ts`; coordinator `facades.ts`, `restore.ts`.

- [ ] Implement reserve/recheck/settle operations and typed adapters for the exact provider methods introduced at M1. Resolve resources from trusted installed capabilities. Do not accept parent/account/role claims from model arguments.
- [ ] Add immutable task/grant scope to facade handles; recheck current epoch on every dispatch and when committing results. Direct provider bindings must be absent from governed callable agent configs.
- [ ] Register a restored hook through the existing Scheduler session, persist schedule ID and logical run key, then record whether it is awaiting user enablement. Runtime `cancelResume` fences delivery immediately and requests upstream hook disable through its supported management path.
- [ ] On callback, atomically admit the run, load bounded checkpoint/evidence/action state, invoke the stored callable, and persist result. Retry duplicate deliveries without starting another logical run. Recover leases after crashes without blindly repeating vendor effects.
- [ ] For wall-clock scheduling require an explicit IANA timezone in task input; use `America/New_York` only when the user/task has supplied that timezone. Test a DST boundary in the same scheduling scenario.

**Focused verification:** one persisted-task scenario containing restart, duplicate delivery, cancelled/revoked grant, simultaneous budget reservation, and continuation from stored evidence. Assert denied calls never reach a provider.

**Acceptance:** a model can end its turn and the same governed objective resumes with enforceable scope and bounded spend; task policy is not merely stored metadata.

## P5 — Narrow agent delegation

### Task 5.1: Profile installation and durable children

**Modify:** coordinator `profiles.ts`, `coordinator.ts`, `facades.ts`; task-runtime `governed-task-do.ts`, `storage.ts`, `task-session.ts`.
**Create:** `packages/gatekeeper-task-runtime/src/children.ts`.

- [ ] Install owner-reviewed spawner profiles containing only task facade resources and scoped task evidence: researcher (read/compute), builder (read/compute/propose), evaluator (read/evaluate), operator (read/propose). None exposes private apply callbacks.
- [ ] Use the existing `spawnCallable(title, prompt)` contract. It does not return a typed child result by itself; persist a child task record and explicitly invoke the callable with a documented request/result schema.
- [ ] Intersect requested methods/resources with parent authority and profile policy. Require strict reduction in at least one authority dimension; reject equivalent or broader grants. Reserve child budget from the parent.
- [ ] Validate callable results into `ChildResult`. Children cannot append authoritative receipts or arbitrary parent state; parent accepts links to child evidence after scope checks.
- [ ] Implement `awaitChildren` as bounded polling/subscription backed by durable child state, not an indefinitely held RPC or DO request. Bound a synchronous wait to 30 seconds, then return a waiting status for later continuation.
- [ ] Builder produces source artifacts/proposals through granted services. Do not expect spawned agents to receive Workshop editing/connection tools; upstream intentionally filters them.

**Focused verification:** extend the durable-task scenario with two differently scoped children, one denied parent-only operation, restart, and result collection. No new suite per profile.

**Acceptance:** one parent can delegate and collect results after restart without increasing authority or duplicating parent budgets.

## P6 — Governed Cloudflare and AI Gateway control

### Task 6.1: Private Cloudflare control and infrastructure plans

**Create package:** `packages/gatekeeper-cloudflare-control/` with standard package/config/types and `SECURITY-REVIEW.md`.
**Source files:** `src/index.ts`, `cloudflare-control.ts`, `api.ts`, `policy.ts`, `actions.ts`, `receipts.ts`, `types.d.ts`, `types-code.ts`, `env.d.ts`.
**Create:** `docs/provider-operation-matrix.md`, `docs/operations-runbook.md`.
**Modify:** deployment catalog/generator/tests; coordinator typed facades.

- [ ] Before enabling each operation, record its current official API, token permissions/resource scope, pagination, idempotency, version/precondition behavior, quotas, entitlements, receipt, and compensation. Account-wide token permissions require a dedicated account or a documented narrower-enforcement decision; never assert a namespace-limited token exists without verification.
- [ ] Observation methods list/describe allowed Workers, versions, bindings, queues, D1 databases, KV namespaces, R2 buckets, and Workflow deployments with bounded pagination. Resource-name prefixes alone are insufficient: maintain owned vendor IDs and deployment identity.
- [ ] Proposal methods create Worker versions/deployments, restore an exact version, and create namespaced Queue/D1/KV/R2 resources. Workflow deployment is an approved Worker deployment with an explicit Workflow binding; no new generic execution API.
- [ ] Normalize infrastructure input to a dependency-ordered immutable resource diff. Store source/artifact hashes, exact bindings, approved compatibility settings, expected existing versions, and per-step compensation. Execution refuses drift against those preconditions.
- [ ] Execute only from the account's private approval callback. Do not export `executeApproved(actionId)` on agent-facing sessions.
- [ ] Journal each resource operation independently. Partial plans retain successful receipts; stop dependent steps and propose compensation. No automatic deletion of populated data stores. Destructive compensation requires its own approval unless the exact empty-resource deletion was explicitly preauthorized.
- [ ] Restrict Worker deployments to operator-approved namespaces and reviewed service bindings. Reject public routes, model-created secrets, control-plane tokens, DNS, Access, security/billing/member settings, and self-deployment over Gatekeepers or runtime.

**Focused verification:** one normalized multi-resource proposal scenario that demonstrates payload substitution denial, vendor version drift, partial failure, receipt read-back, and compensation proposal. Reuse the Stage execution harness.

### Task 6.2: AI Gateway telemetry, benchmark, and route proposals

**Create package:** `packages/gatekeeper-ai-gateway/` with standard package/config/types and `SECURITY-REVIEW.md`.
**Source files:** `src/index.ts`, `ai-gateway.ts`, `logs.ts`, `dynamic-routes.ts`, `benchmark.ts`, `policy.ts`, `types.d.ts`, `types-code.ts`, `env.d.ts`.

- [ ] Expose bounded log/route reads with provider, model, duration, usage, cost when reported, cache status, and task/run IDs. Bodies are omitted by default; any body access requires separate data scope.
- [ ] Implement bounded benchmark jobs over explicit cases and allowed model candidates. Default at most 5 candidates, 50 cases, concurrency 2, and per-case timeout 60 seconds. Require a finite task spend ceiling and reserve worst-case token cost before every request.
- [ ] Persist asynchronous benchmark progress and results instead of holding a long RPC. Separate benchmark transport from route management credentials; neither returns provider keys.
- [ ] Expose `proposeRouteVersion` and `proposeRouteDeployment` only. Bind exact normalized graph/hash, expected currently deployed version, destination route, traffic share, and fallback. Execute privately after approval and read back the deployed state.
- [ ] Benchmarking never changes production routing. Default autonomous production traffic share is zero; an experiment policy may approve a specific bounded canary percentage and expiry.
- [ ] On missing prices, usage, request bodies, or deployment APIs return explicit unavailable capability/status; do not convert unknown values to zero.

**Focused verification:** one benchmark-to-route fixture proving budget exhaustion halts dispatch and only the approved graph/version can be deployed. Live routing behavior is verified against a dedicated nonproduction route.

### Task 6.3: Audit and operational enablement

**Modify:** all new mutation adapters and task runtime; `docs/operations-runbook.md`, `docs/provider-operation-matrix.md`.

- [ ] Emit append-only application audit events containing task/run/action/attempt/experiment IDs, policy version, payload digest, actor, model, target, timestamps, and redacted vendor receipt references.
- [ ] Persist action journal before external I/O; export audit metadata durably with retry. Application append-only does not imply immunity to account-admin tampering; document the actual storage/retention boundary.
- [ ] Add operator switches to disable new proposals, new executions, compute dispatch, factory creation, or an entire task independently. Reconciliation remains available while writes are disabled.
- [ ] Document recovery for uncertain vendor outcomes, expired credentials, revoked accounts, budget exhaustion, schedule backlog, partial infrastructure plans, and missing receipt exports. Alert on indeterminate mutations and growing unreconciled attempts.
- [ ] Rehearse backup/restore and schema upgrade against fixture DO data. Prefer forward-compatible migrations; mark migrations that prohibit binary rollback and supply a forward recovery procedure.

**Acceptance:** operators can reconstruct every enabled mutation and stop new effects. These controls ship with P6, not after it.

## P7 — Bounded executable capability factory

### Task 7.1: Factory substrate and manifest

**Create package:** `packages/gatekeeper-capability-factory/` with standard Worker configuration, package/types, and `SECURITY-REVIEW.md`.
**Source files:** `src/index.ts`, `factory.ts`, `manifest.ts`, `policy.ts`, `registry.ts`, `dispatch.ts`, `outbound.ts`, `cleanup.ts`, `types.d.ts`, `types-code.ts`, `env.d.ts`.
**Modify:** deployment generator to produce a private factory and separate private outbound Worker; operation matrix; coordinator facade.

- [ ] Verify Workers for Platforms entitlement, dispatch API permissions, namespace ownership, custom limits, deployment latency, and integration with Code Mode RPC before activation.
- [ ] V1 accepts one bundled ES-module JavaScript source. Reject TypeScript source requiring compilation, remote imports, arbitrary compatibility flags, model-chosen namespace/name, uploaded secrets, and arbitrary bindings.
- [ ] Initial manifest: server ID, owner/task, source hash, policy version, expiry, allowed exports, request/response byte ceilings, CPU/subrequest ceilings. Default TTL 15 minutes, source 256 KiB, request 256 KiB, response 1 MiB, CPU 100 ms, outbound subrequests zero, 5 active capabilities per task. Platform limits may require lower settings.
- [ ] Start ephemeral capabilities with **zero egress and zero provider/mutation bindings**. This fully supports missing transforms/adapters. Additional outbound access uses the separately defined policy in Task 7.3 and remains disabled until its proof passes.
- [ ] Register creation as a bounded, auditable preauthorized mutation. Require tenant/task ownership on validate/create/invoke/dispose/revoke. Promotion requires Stage approval of exact source/manifest/binding/policy hashes.

### Task 7.2: Live handle and crash-safe lifecycle

- [ ] Return an opaque RPC handle exposing `describe`, `invoke`, and `dispose`. `invoke` accepts a bounded payload and a declared adapter export; it does not accept arbitrary URLs or headers. Server code constructs the dispatch request.
- [ ] Prove one real Code Mode execution can create, invoke, and dispose a handle over the actual RPC bridge without Workshop env mutation. Do not expose the raw dispatch namespace binding.
- [ ] Registry states: `creating`, `ready`, `expired`, `deleting`, `deleted`, `indeterminate`. Persist deterministic request identity before upload; read back source/metadata hash before ready. Invocation checks expiry/policy even if deletion is delayed.
- [ ] Delete expired scripts through durable alarms plus periodic inventory reconciliation. Handle upload-success/registry-crash and deletion-failure cases; sweep only exact owned script IDs. Bound active scripts and creation rate independently of per-invocation CPU.
- [ ] Disposal releases RPC resources and requests cleanup; lease expiry protects against abandoned handles. Promoted scripts still require explicit lifetime, usage budget, ownership, and revocation policy.

**Focused verification:** one real dispatch lifecycle scenario containing creation/invocation in the same Code Mode program, cross-task denial, expiry, orphan reconciliation, and disposal. A static source check alone is not an isolation test.

### Task 7.3: Optional outbound extension

- [ ] Outbound Worker denies all by default. Permit only operator-owned or vetted HTTPS origins with fixed allowed methods/paths, no IP literals/userinfo/custom ports, and no automatic redirects. Reject redirects rather than attempting an unsafe hostname-only redirect policy.
- [ ] Pass immutable owner/task/capability policy from dispatcher. Strip authorization/cookie/proxy headers; inject vendor credentials only inside a separately reviewed provider adapter, never inside generated code.
- [ ] Enforce byte limits while streaming and aggregate subrequest counts. Exclude DO, mTLS, socket, and indirect service bindings that could escape outbound enforcement.
- [ ] For origins requiring private-address/DNS guarantees, demonstrate platform-enforced connection policy or use a governed provider binding. Do not claim a hostname allowlist or a source scan prevents DNS rebinding.

**Acceptance:** zero-egress factory is required for M2. Network-enabled generated capabilities are an optional extension and remain disabled until these connection-level guarantees can be demonstrated.

## P8 — Evaluation, model selection, and complete operating loop

### Task 8.1: Evaluation records and metric ownership

**Create:** `packages/gatekeeper-task-runtime/src/evaluation.ts`, `experiments.ts`.
**Modify:** task/runtime types, AI Gateway benchmark, coordinator, operator guide.

- [ ] Implement threshold, baseline/candidate comparison, and bounded all/any evaluation trees. Metric references identify a registered metric, exact resource, time window, aggregation, units, and provenance.
- [ ] Metric sources: Snowflake scalar query, AI Gateway cost/duration/error rate, Cloudflare telemetry, bounded model evaluator, and registered task-specific evaluators. Model-provided scores are claims unless produced by the configured trusted evaluator.
- [ ] Define missing/insufficient/delayed data as `inconclusive`; do not mark success on empty telemetry. Require minimum sample count, bounded observation delay, fixed dataset split and evaluator version for comparisons. Record uncertainty and avoid claiming causation from an uncontrolled before/after comparison.
- [ ] Store baseline evidence, hypothesis, exact action references/receipts, observation window, criteria, result, and proposed next action. Evaluation cannot grant itself authority.

### Task 8.2: Model tournament and governed correction

- [ ] Use Snowflake or a reviewed artifact as representative evaluation cases; reserve a holdout set. Compare allowed HF/NVIDIA/AI Gateway models under the same evaluator and cost/latency/reliability constraints.
- [ ] Rank only candidates meeting all constraints. Persist raw bounded results and pricing assumptions; no winner is a valid result if all fail or data is insufficient.
- [ ] Produce an AI Gateway route proposal for the selected candidate/fallback graph. Require approval for version/deployment, then collect post-deployment telemetry after the scheduled observation window.
- [ ] Keep the change, propose exact prior-version restoration, or propose a next iteration. Use recorded expected current version to detect competing operator changes. Automatic compensation requires an explicit preauthorized operation, target, and condition.

### Task 8.3: M2 acceptance and rollout

**Modify:** `packages/operating-environment-tests/src/composition.test.ts`, `docs/code-mode-operator-guide.md`, `docs/operations-runbook.md`, `README.md`.

- [ ] Run the five system scenarios in section 6 against the final release candidate.
- [ ] Publish a capability matrix marking each capability implemented, configured, verified live, disabled, or unavailable. A package compiling does not make its feature available.
- [ ] Review generated service graph and migration order; deploy the private dependency Workers before consumers and Router last. Initial exposure is a designated operator workspace with finite budgets and disposable vendor resources.
- [ ] Verify live OAuth/bootstrap, one approved write per distinct vendor protocol, restart/resume, factory cleanup, and one route experiment. Capture IDs/hashes and outcomes without private payloads.
- [ ] Promote activation per packet only after its evidence passes. Release notes name the achieved milestone and remaining optional extensions.

**Acceptance:** one objective can complete the full governed loop after its originating model context has ended; operators can inspect, revoke, reconcile, and recover it.

## 6. Verification budget — no test soup

Keep existing root tests. New verification concentrates on five shared system scenarios:

| Scenario | What it must prove |
|---|---|
| A. Enterprise composition | Real Workshop Code Mode binding path combines Snowflake + model provider + GitHub/Confluence; a revoked resource cannot be read |
| B. Governed mutation | Exact approval subject, private apply, durable receipt, rejection/expiry, concurrent execution, and crash reconciliation |
| C. Persistent delegation | Restart/resume, duplicate admission, bounded child authority, shared spend ceiling, cancellation, durable results |
| D. Missing adapter | Same-execution factory create/invoke/dispose, cross-task isolation, expiry, no egress, orphan cleanup |
| E. Empirical correction | Baseline -> proposal -> approval -> receipt -> wait -> observe -> evaluation -> keep/compensation, including inconclusive data |

Use focused existing-unit-suite regressions only for distinct bugs: Stage transitions, HF wire serialization, Snowflake generated target, Unicode byte accounting, and secret/service graph isolation. Add a provider fixture when its wire protocol cannot be covered by another fixture. Do not retest shared Stage behavior in every provider package.

Avoid snapshotting entire generated repositories, mocking every helper, generic getter/setter tests, per-field tests, broad benchmark farms, and arbitrary sleeps. Use deterministic event/crash injection and real workerd persistence for lifecycle claims. Prefer a test with one meaningful failure over many assertions about implementation layout.

Default local validation during implementation is the touched package's existing focused suite and type check. At packet completion run:

```powershell
pnpm test
pnpm lint
pnpm check
```

Frozen dependency installs belong to a fresh baseline/CI or an intentional dependency update, not every small edit. Root check builds and performs Wrangler dry runs; it writes and removes generated files and may refresh ignored build outputs. It does not prove remote permissions. Root tests do not cover all inner tests: run the relevant upstream integration suite when a compatibility seam changes, and the full inner suite only for an upstream revision change or evidence of broader breakage.

## 7. Release and recovery rules

Each packet carries source/type/config changes, focused evidence, migration/compatibility notes, operator documentation, enable/disable settings, and its live verification status. Commit only packet files after review; preserve unrelated local changes. Remote deployment and live mutations require the user's release authorization.

Migration order: introduce compatible storage readers -> deploy private providers/runtime/outbound dependencies -> migrate/backfill safely -> deploy coordinator/Workshop binding changes -> enable one operator workspace -> inspect receipts -> expand. Never drop old schema or namespaces in the same packet that introduces their replacement.

Rollback distinguishes code rollback, configuration rollback, exact vendor version restoration, and compensating operations. Data-store deletion and irreversible changes are not ordinary rollback. Stop new work first, retain journals, reconcile in-flight effects, then restore only where preconditions and data compatibility permit.

Required operational evidence: all generated private Workers lack direct exposure; no real secrets in generated artifacts or logs; ownership survives restore; task/action/event IDs correlate; pending vendor outcomes are visible; kill switches prevent new effects; orphaned factory scripts are identified and retired.

## 8. Source evidence and platform checks

Repository source is authoritative for current contracts; this plan specifies future outer additions. The original proposal's interfaces such as agent-facing `executeApproved` and Scheduler exactly-once wording are superseded by this document.

- [Workers RPC lifecycle](https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/): verify lifetime and persistence against the exact RPC bridge in use; native RPC and Cap'n Web objects are not interchangeable by assumption.
- [Workers for Platforms outbound Workers](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/outbound-workers/): outbound fetch mediation has explicit DO/mTLS exclusions. P7 therefore starts with zero egress and excludes those bindings.
- [Workers for Platforms custom limits](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/custom-limits/): use platform CPU/subrequest limits plus explicit application byte/TTL/accounting controls.
- [AI Gateway dynamic routing](https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/): validate current graph/version/deployment APIs and permissions before enabling route management.
- [Hugging Face Hub client contract](https://huggingface.co/docs/huggingface_hub/package_reference/hf_api): capture a fixture from the matching official commit implementation, including parent commit and returned OID semantics.
- [Snowflake SQL API](https://docs.snowflake.com/en/developer-guide/sql-api/index): verify request identifiers, retry, statement status, bindings, and least-privilege role behavior in Task 1.3.
- [Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/): confirm the installed first-deploy secret-file option instead of assuming a command from a newer release.

Outbound Workers, custom limits, dynamic routing, and Hub documentation were consulted while preparing this plan. Account-specific availability, exact API permission scopes, and live integration behavior remain explicit implementation/activation gates rather than asserted facts.

## 9. Completion checklist

- [ ] M1: real multi-provider Code Mode composition is usable from configured accounts/resources.
- [ ] Existing provider defects and lint failures are corrected.
- [ ] Every new write is scoped to an immutable approval subject and journaled execution attempt.
- [ ] No agent-visible action-ID execution bypass exists.
- [ ] Task grants, budgets, expiry, revocation, and child narrowing are enforced on actual calls.
- [ ] Tasks resume after restart with stable logical run admission and reconciled external effects.
- [ ] Infrastructure/model route operations have versioned receipts and explicit compensation limits.
- [ ] Zero-egress adapters are immediately usable through opaque handles and expire reliably.
- [ ] Evaluation can distinguish success, failure, and insufficient evidence.
- [ ] All five system scenarios and packet checks pass; live readiness is documented separately.
- [ ] Documentation accurately states M1/M2 achievement and unavailable optional capabilities.

The next implementation unit is P0. P1 follows only after its baseline and release-check evidence is recorded. No later packet may bypass an unmet integration or authority prerequisite.
