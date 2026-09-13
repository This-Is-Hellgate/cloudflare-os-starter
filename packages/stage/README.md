# @gadgets/stage

The shared durable action ledger for Gatekeepers.

A **Stage** owns the `staged → pending → approved/rejected` state machine that every consequential
action passes through before a vendor write executes. It is the durable, inspectable record of what
was proposed, what state it sits in, and — after rejection — the evidence that a human decided
against it. Gatekeepers supply their vendor payload; Stage supplies the ledger.

## Why it exists

Snowflake and Hugging Face independently converged on the same hand-rolled ledger: sequential ids
from a durable counter, an explicit staged state before submission, retire-not-delete on rejection,
and proposal lookups across live and retired records. Stage is that proven pattern extracted once so
future Gatekeepers do not re-derive it.

## Usage

```ts
import { Stage } from "@gadgets/stage";

// Inside a Durable Object:
readonly #stage = new Stage<WritePayload>({ kv: this.ctx.storage.kv, label: "Snowflake" });

const actionId = await this.#stage.stage({ proposalId, operation, target, sql });
try {
  await queue.submitAction(actionId, description);
} catch (error) {
  await this.#stage.discardStaged(actionId); // only staged records are discardable
  throw error;
}
await this.#stage.markPending(actionId);
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
