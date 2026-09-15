// GatedActions: the shared write-action lifecycle for Stage-backed Gatekeepers.
//
// Decision and execution are separate. The overseer's `applyAction()` callback is the only trusted
// approval signal; a session's proposal path never executes. The flow:
//
//  - `proposeAction()` (session side) persists the submission intent — the record enters "pending"
//    BEFORE `submitAction()` is called — then submits. A thrown submission is retained for
//    reconciliation, never deleted: the queue may own the action even if the call failed, and an
//    auto-approved callback can arrive before `submitAction()` returns.
//  - `GatedActions.apply()` (overseer side, private to the owning DO) is the only execution entry.
//    It refuses rejected/expired/quarantine/resubmission-required actions and foreign subjects
//    BEFORE vendor I/O, records the trusted decision through Stage's one-way transition table, and
//    hands execution to the ExecutionJournal: atomic attempt claims, durable receipts,
//    indeterminate recovery. "Approved" is a decision, never a synonym for a successful write.
//
// Both pieces were proven independently by the Snowflake and Hugging Face gatekeepers before
// being extracted here; their executor callbacks remain vendor-specific.

import type { ActionRef, ApprovalSubject, ExecutionAttempt } from "./contracts.js";
import { isExpired } from "./contracts.js";
import type { ExecutionJournal, ExecutionOutcome, ReceiptInput, VendorProbe } from "./execution.js";
import type { Stage, StageRecord } from "./stage.js";

/** The description an approval queue receives for a submitted action. */
export interface ActionDescription {
  title: string;
  description: string;
  implementsRevert: boolean;
  awaitDecision?: boolean;
}

/** The structural subset of an approval queue that submitting an action needs. */
export interface ActionSubmitter {
  submitAction(actionId: number, description: ActionDescription): Promise<unknown>;
}

/**
 * The structural subset of a Stage-backed Gatekeeper that a session uses to drive a staged
 * action through the approval queue. Satisfied by the Gatekeeper Durable Object itself, whether
 * the session holds it in-process or over RPC. `stageAction` binds the trusted subject and
 * payload hash at staging time.
 */
export interface StagedActionSink<P> {
  stageAction(payload: P): Promise<number>;
  markActionPending(actionId: number): Promise<void>;
  discardStagedAction(actionId: number): Promise<void>;
}

export interface ApplyOptions<P> {
  /** Operator gate: the executor runs only when this is true. */
  writesEnabled: boolean;
  /** Thrown when `writesEnabled` is false. Name the enabling variable so operators can act. */
  disabledMessage: string;
  /**
   * The trusted subject for this action, rebuilt from session/account context by the owning DO
   * (never from model-visible arguments). Scope, policy version, and payload hash are rechecked
   * against the bound record before vendor I/O.
   */
  subject: ApprovalSubject;
  ref: ActionRef;
  /**
   * The vendor executor. Runs only after every gate passes, and must re-validate the stored
   * payload — the durable record, not the session's arguments, is what the executor acts on.
   */
  execute: (record: StageRecord<P>, attempt: ExecutionAttempt) => Promise<ReceiptInput>;
  /** Bounded vendor read-back used to settle indeterminate outcomes. */
  probe?: VendorProbe;
}

export interface ProposedAction {
  proposalId: string;
  actionId: number;
}

/**
 * The overseer-facing side of the lifecycle. Constructed inside a Gatekeeper Durable Object,
 * next to the Stage and the ExecutionJournal it drives. This class is the ONLY approval
 * execution entry: no staged-to-executed shortcut exists, and no session-visible method reaches
 * it — the model's session types do not include the Gatekeeper DO's action methods.
 */
export class GatedActions<P extends { proposalId: string }> {
  readonly #stage: Stage<P>;
  readonly #label: string;
  readonly #journal: ExecutionJournal;

  constructor(stage: Stage<P>, label: string, journal: ExecutionJournal) {
    this.#stage = stage;
    this.#label = label;
    this.#journal = journal;
  }

  /**
   * Applies an approved action. Invoked through the owning upstream approval capability — the
   * trusted decision signal. Idempotent on overseer re-delivery: a settled success returns the
   * durable outcome without dispatch; an indeterminate outcome goes to the vendor probe, never
   * to a blind retry.
   */
  async apply(actionId: number, options: ApplyOptions<P>): Promise<ExecutionOutcome> {
    // --- gates that refuse BEFORE vendor I/O ---------------------------------------------
    const record = await this.#stage.require(actionId);

    if (record.quarantined) {
      throw new Error(`${this.#label} action ${actionId} is quarantined for operator reconciliation.`);
    }
    if (record.requiresResubmission) {
      throw new Error(`${this.#label} action ${actionId} predates approval binding and requires resubmission.`);
    }
    if (record.state === "staged") {
      // Staged-to-executed shortcut removed: submission never completed.
      throw new Error(`${this.#label} action ${actionId} never completed submission; resubmit it.`);
    }
    if (record.state === "rejected") {
      throw new Error(`${this.#label} action ${actionId} is no longer pending.`);
    }
    if (record.state === "expired") {
      throw new Error(`${this.#label} action ${actionId} expired before execution.`);
    }
    // Foreign action: the bound subject's scope must match the DO's current trusted context.
    if (record.subject) {
      const bound = record.subject;
      const scope = ["ownerId", "accountId", "workspaceId", "operation", "resource", "policyVersion"] as const;
      for (const field of scope) {
        if (bound[field] !== options.subject[field]) {
          throw new Error(`${this.#label} action ${actionId} does not match the submitted approval subject.`);
        }
      }
      // Expiry recheck at execution time, against the bound expiry.
      if (isExpired(bound, Date.now())) {
        if (record.state === "pending") await this.#stage.decide(actionId, "expired");
        throw new Error(`${this.#label} action ${actionId} expired before execution.`);
      }
    }

    // --- trusted decision ------------------------------------------------------------------
    // The record must be pending here. If a previous delivery already recorded the decision
    // (terminal "approved"), the journal's settled state decides idempotency.
    if (record.state === "pending") await this.#stage.markApproved(actionId);

    // --- journaled execution ----------------------------------------------------------------
    // The bound payload hash is authoritative: the executor acts on the durable record and
    // re-validates it against current policy itself.
    return this.#journal.executeApproved({
      ref: options.ref,
      subject: { ...options.subject, payloadHash: record.payloadHash ?? options.subject.payloadHash },
      record,
      writesEnabled: options.writesEnabled,
      disabledMessage: options.disabledMessage,
      execute: options.execute,
      probe: options.probe,
    });
  }
}

/**
 * The session-facing side of the lifecycle: stage the payload (the owning DO binds the trusted
 * subject and payload hash at staging), persist the submission intent (pending BEFORE the call),
 * submit, and retain — never delete — a record whose delivery outcome is unknown. An action the
 * queue may own is reconciled by an operator or by resubmission, not discarded behind the
 * queue's back.
 */
export async function proposeAction<P extends { proposalId: string }>(
  sink: StagedActionSink<P>,
  submitter: ActionSubmitter,
  payload: P,
  description: ActionDescription,
): Promise<ProposedAction> {
  const actionId = await sink.stageAction(payload);
  // Submission intent: pending is durable before submitAction() runs, so an auto-approved
  // callback racing this call finds an open, appliable record.
  await sink.markActionPending(actionId);
  // Delivery outcome unknown on throw: the queue may have received it. The record stays
  // pending for reconciliation — this call deliberately does not discard it.
  await submitter.submitAction(actionId, description);
  return { proposalId: payload.proposalId, actionId };
}
