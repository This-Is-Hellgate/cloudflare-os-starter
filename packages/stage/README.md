# @gadgets/stage

The shared durable action ledger and gated write lifecycle for Gatekeepers.

A **Stage** owns the `staged → pending → approved/rejected` state machine that every consequential
action passes through before a vendor write executes. It is the durable, inspectable record of what
was proposed, what state it sits in, and — after rejection — the evidence that a human decided
against it. **GatedActions** owns the lifecycle every Gatekeeper plays out around that ledger: the
overseer's idempotent `apply()` and the session's stage/submit/discard-on-rejection propose flow.
Gatekeepers supply their vendor payload and executor; Stage supplies the ledger and lifecycle.

## Why it exists

Snowflake and Hugging Face independently converged on the same hand-rolled ledger: sequential ids
from a durable counter, an explicit staged state before submission, retire-not-delete on rejection,
and proposal lookups across live and retired records. Stage is that proven pattern extracted once so
future Gatekeepers do not re-derive it.

## Usage

```ts
import { Stage, GatedActions, proposeAction } from "@gadgets/stage";

// Inside a Durable Object:
readonly #stage = new Stage<WritePayload>({ kv: this.ctx.storage.kv, label: "Snowflake" });
readonly #gated = new GatedActions(this.#stage, "Snowflake");

const actionId = await this.#stage.stage({ proposalId, operation, target, sql });
try {
  await queue.submitAction(actionId, description);
} catch (error) {
  await this.#stage.discardStaged(actionId); // only staged records are discardable
  throw error;
}
await this.#stage.markPending(actionId);

// The overseer's entry point, idempotent on re-delivery:
async applyAction(actionId: number) {
  await this.#gated.apply(actionId, {
    writesEnabled: writesEnabled(this.env),
    disabledMessage: "…",
    execute: (record) => this.#execute(record), // vendor-specific, re-validates the stored payload
  });
}
```

## Invariants

1. **Sequential ids from a durable counter** (`counter:action`), never from the clock.
2. **Explicit `staged` state** before submission — a crash between staging and submission leaves a
   discardable record, not a half-registered action.
3. **Retire, don't delete**: rejection moves `action:{id}` → `retiredAction:{id}`; the record stays
   as durable evidence of the decision.
4. **Lookups consult live and retired records** (`get`, `require`, `findByProposalId`).
5. **`discardStaged` only deletes `staged` records** — submitted actions belong to the approval
   flow and are never silently dropped.

## Storage

Stage codes against a minimal structural subset of `DurableObjectStorage["kv"]`
(`SyncKvStorage`): synchronous `get`/`put`/`delete`/`list`. Pass `this.ctx.storage.kv` directly;
tests use a Map-backed fake (see `__tests__/stage.test.ts`).

## Records

`StageRecord<P>` is the vendor payload `P` (which must carry `proposalId`) plus the ledger fields
Stage owns: `actionId`, `state`, `submittedAt`, and optionally `appliedAt`/`rejectedAt`. The
structured record is canonical; human-readable approval descriptions are views derived from it by
the caller.

## Gated lifecycle

`GatedActions.apply(actionId, options)` is the overseer-facing `applyAction` every Stage-backed
Gatekeeper implements. It is idempotent on re-delivery (an already-approved action is a no-op),
gated on the record still being open (`staged`/`pending`), gated on an explicit operator flag
(`writesEnabled`), and only then runs the vendor `execute` callback and records approval. The
executor callback must re-validate the stored payload — the durable record, not the session's
arguments, is what executes.

`proposeAction(sink, submitter, payload, description)` is the session-facing propose flow: stage
the payload, submit it to the approval queue, discard the staged record if the queue rejects the
submission (so no orphaned action id lingers), and mark it pending once accepted. `sink` is the
structural subset of the Gatekeeper DO the session already holds
(`stageAction`/`markActionPending`/`discardStagedAction`); `submitter` is the approval queue.

Both pieces are tested behaviorally in `__tests__/` against a Map-backed `SyncKvStorage` fake;
gatekeeper packages pin their delegation with source-level contract tests.
