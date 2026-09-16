# Code Mode operator guide

How an enterprise resource goes from `deployment.jsonc` to a governed call inside a generated
Code Mode program, and what changes when an agent's turn ends. This guide reflects the pinned
kernel at `0272b060` (pi-agent-core model layer, per-turn agent catalogs, redesigned
`spawnCallable`).

## The chain, end to end

```text
1. DEPLOY     deployment.jsonc -> scripts/deploy.ts -> one Worker per enabled Gatekeeper
              (secrets installed per Worker first: docs/deployment-secrets.md)
2. ENABLE     The vendor's GatekeeperVendor entrypoint advertises the provider in Connections
              (describe(): displayName, tagline, autoProvisionsAccount).
3. CONNECT    Connect/provision the account:
              - OAuth providers (github, confluence, cloudflare): the per-user OAuth flow runs
                against the Router's /gatekeeper/<id>/oauth route; the account DO stores the
                grant and completes the connect callback.
              - Credential providers (snowflake, huggingface): the deployment's configured
                credential is used directly (singleton account).
4. AUTHORIZE  Pick the resource (snowflake://account, https://huggingface.co/models/<org>/<repo>)
              in the resource configurator; the Gatekeeper DO is instantiated with the bound
              resource identity.
5. BIND       Bind the resource to a workspace/chat binding (gatekeeper adapter + URL pattern).
              Workshop verifies observers before sharing (Gatekeeper.addObserver).
6. TYPES      Workshop reads getTypeScriptTypes() and generates the model-visible session
              catalog: the typed facade the agent's Code Mode program sees.
7. EXECUTE    Code Mode: the model writes a program against those types; calls flow over
              Cap'n Web RPC to the session, gated by authorizeObservation() and the approval
              queue; writes flow through Stage -> approval -> ExecutionJournal.
```

## Binding names

The generated configs use these stable suggested binding names (operator conventions, not
automatic env injection — the Workshop discovers `GATEKEEPER_*` service bindings by scanning its
env):

| Binding | Provider |
| --- | --- |
| `SNOWFLAKE` | Snowflake |
| `HUGGINGFACE` | Hugging Face |
| `NVIDIA` | NVIDIA (P3) |
| `GITHUB` | GitHub |
| `CONFLUENCE` | Confluence |
| `CLOUDFLARE_OBSERVABILITY` | Cloudflare telemetry |
| `SCHEDULER` | Scheduler (ambient) |

## What the agent can see: discovery vs the method contract

- **`getAgentCatalog()` is discovery metadata only.** It is delivered into every chat's prompt on
  every turn, is NOT an observation (no observer verification), and must never carry anything that
  would need observer verification — titles and descriptions only. Reading an item through the
  session is where the observation happens.
- **The generated session types are the method contract.** An agent can only call what
  `types-code.ts` declares; anything else fails RPC shape validation before it is stored. The
  `types-code.ts`/`types.d.ts` hand-sync is enforced by each package's test suite.

## Multi-gadget workspaces

A workspace is no longer one gadget: it contains numbered **workpieces** (gadgets and gatekeeper
connections in one shared ID namespace; upstream plan `cloudflare-os/plans/multi-gadget.md`).

- Workspaces can start empty; agents create gadgets explicitly with the `createGadget` tool
  (creation is crash-safe and provisional to the chat that made it).
- **Bindings are per-gadget edges.** Two gadgets can bind the same gatekeeper connection, each
  annotating it differently for blueprint consumers. Binding names live on the gadget's binding
  map, not on the gatekeeper record.
- **Approval policy is workspace-wide per gatekeeper.** Approving an action kind approves it no
  matter which gadget invoked it; actions and hooks identify the gatekeeper, not a binding name.
- Removing a connection in the UI unbinds it from one gadget; the gatekeeper record survives
  (orphaned connections are surfaced for cleanup).
- Agent file tools take a `workpieceId`; absent references resolve to the workspace's
  `defaultGadgetId` (never reassigned — a deleted gadget fails references explicitly).

## Step transactionality

A model **step** (one model request plus its tool batch; upstream plan
`cloudflare-os/plans/step-transactionality.md`) commits atomically: the step's tool-call transcript
record and every content effect it produced land in **one storage transaction** at the step
barrier. Consequences for the governed loop:

- A crash mid-step leaves no half-applied content the transcript cannot account for — replay sees
  all-or-nothing.
- `executeCode` after buffered edits in the same step throws a retryable, agent-visible error
  ("changes land next step — retry") instead of running provisional code.
- **Gatekeeper effects are explicitly out of step-rollback scope**: our Stage proposals still
  require the real approval flow before any vendor effect, which is the stronger guarantee.

## Model routing (pi layer)

All inference is HTTPS-with-tokens: the deployment's AI Gateway route uses
`CF_AI_GATEWAY_API_TOKEN`, and BYOK keys run through the user's unified gateway `/compat`
endpoint with compound `{provider}/{model}` identifiers. The `WORKERS_AI` binding remains only for
webFetch document conversion and gateway log-cost. `SUGGESTED_MODELS` (workshop-shared) is the
authoritative source for context windows and output limits.

## Writes: the approval path

A Code Mode program never executes a write directly. `proposeWrite`/`proposePlan` stages a
normalized plan (the plan is what gets approved and journaled), pauses via `awaitDecision`, and
the human decision lands through the overseer callback into the DO's journaled execution. Agents
see honest state via `getWriteProposal` (`simulated` stays true until the execution journal holds
a settled success). Operator-installed preauthorization patterns execute without the queue
round-trip but with recorded provenance; the model can never select a pattern itself.

## Timing: what an agent sees after a change

- **Buffered gadget edits require a later agent step.** A deployment binding added while an agent
  is running appears in that agent's generated types only on a later step — never mid-execution.
- **Connections and agent catalogs are re-read every turn.** With the pinned kernel, catalog
  metadata is refreshed each turn rather than cached on the chat, so a newly connected resource
  appears in the model-visible catalog on the next turn. A revocation likewise takes effect by the
  next turn; an in-flight execution completes against its own authorized session and fails at the
  vendor boundary if the credential no longer works.
- **Never promise a new deployment binding appears halfway through an existing execution.**

## Reconnect and revocation

- **OAuth providers** (github, confluence): refresh happens transparently against the rotating
  refresh token; no token-cache expiry is reported to the callback (upstream #509). Revoking the
  account disconnects the per-user grant.
- **Credential providers** (snowflake, huggingface): reconnect is intentionally unsupported —
  `reconnect()`/`commitReconnect()` throw with an explicit message; rotate the deployment
  credential instead. Account isolation is preserved: each resource binding scopes exactly one
  account/resource, and there is no simulated successful OAuth path.
- **Revocation fails closed before provider data is returned:** observers must be verified before
  a binding is shared (`addObserver` refuses untracked observers), and a revoked connection's
  session calls fail at the vendor boundary rather than returning cached data.

## Verifying the chain

The remaining acceptance evidence (connected resources callable together after reconnect, revoked
access failing before data returns) is exercised by the shared operating-environment harness
(Task 3.2), which drives the real Workshop and real gatekeepers under the upstream
`@gadgets/integration-tests` toolkit (`harness`, `network-interceptor`, `rpc-client`).
