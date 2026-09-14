/**
 * GatedActions: the shared write-action lifecycle for Stage-backed Gatekeepers.
 *
 * Stage owns the ledger (the durable record and its state machine). GatedActions owns the
 * lifecycle every Gatekeeper plays out around that ledger:
 *
 *  - `apply()` is the overseer's entry point. It is idempotent on re-delivery, gated on the
 *    action still being open (staged/pending), gated on an explicit operator enable flag, and
 *    only then runs the vendor executor and records approval.
 *  - `proposeAction()` is the session's entry point. It stages the payload, submits it to the
 *    approval queue, drops the staged record if the queue rejects the submission, and marks the
 *    action pending once the queue accepted it.
 *
 * Both pieces were proven independently by the Snowflake and Hugging Face gatekeepers before
 * being extracted here; their executor callbacks remain vendor-specific.
 */

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
 * the session holds it in-process or over RPC.
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
   * The vendor executor. Runs only after the state gate and operator gate pass, and must
   * re-validate the stored payload — the durable record, not the session's arguments, is what
   * the executor acts on.
   */
  execute: (record: StageRecord<P>) => Promise<void>;
}

export interface ProposedAction {
  proposalId: string;
  actionId: number;
}

/**
 * The overseer-facing side of the lifecycle. Constructed inside a Gatekeeper Durable Object,
 * next to the Stage it gates.
 */
export class GatedActions<P extends { proposalId: string }> {
  readonly #stage: Stage<P>;
  readonly #label: string;

  constructor(stage: Stage<P>, label: string) {
    this.#stage = stage;
    this.#label = label;
  }

  /**
   * Applies an approved action. Idempotent on overseer re-delivery: a crash after the vendor
   * write but before the overseer recorded completion replays apply, and the durable record is
   * the only authority on whether the mutation already ran — so an already-approved action
   * reports success rather than throwing (which would strand the action as forever
   * un-appliable).
   */
  async apply(actionId: number, options: ApplyOptions<P>): Promise<void> {
    const record = await this.#stage.require(actionId);
    if (record.state === "approved") return;
    if (record.state !== "pending" && record.state !== "staged") {
      throw new Error(`${this.#label} action ${actionId} is no longer pending.`);
    }
    if (!options.writesEnabled) throw new Error(options.disabledMessage);
    await options.execute(record);
    await this.#stage.markApproved(actionId);
  }
}

/**
 * The session-facing side of the lifecycle: stage the payload, submit it to the approval queue,
 * and mark it pending — discarding the staged record if the queue rejects the submission, so no
 * orphaned action id lingers.
 */
export async function proposeAction<P extends { proposalId: string }>(
  sink: StagedActionSink<P>,
  submitter: ActionSubmitter,
  payload: P,
  description: ActionDescription,
): Promise<ProposedAction> {
  const actionId = await sink.stageAction(payload);
  try {
    await submitter.submitAction(actionId, description);
  } catch (error) {
    await sink.discardStagedAction(actionId);
    throw error;
  }
  await sink.markActionPending(actionId);
  return { proposalId: payload.proposalId, actionId };
}
