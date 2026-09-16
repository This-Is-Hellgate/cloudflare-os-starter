// ExecutionJournal: the durable execution record for approved actions.
//
// Decision and execution are separate. The owning DO's overseer callback (applyAction) is the only
// trusted approval signal; this journal owns everything that happens after it: atomic attempt
// claims, immutable attempts, durable receipts, and recovery of outcomes the vendor accepted but
// this DO never recorded.
//
// Atomicity uses the owning DO's real storage semantics: the caller supplies `runExclusive`,
// satisfied by `this.ctx.blockConcurrencyWhile.bind(this.ctx)`. While an execution block runs, the
// DO queues every other event, so concurrent callers cannot interleave between the attempt claim
// and settlement, and redelivery behind a live execution sees its settled outcome. No multi-step
// awaited KV sequence is presented as a concurrency guarantee.
//
// The lease epoch is a DO-lifetime counter minted here: each new DO instance claims the next epoch
// on its first exclusive block. Attempts persist the epoch that claimed them; `recover()` retires
// attempts left "executing" by an earlier epoch to "indeterminate" -- a vendor effect may exist,
// and only a reconciliation probe (not a blind retry) may settle it.

import type { ActionRef, ApprovalSubject, ExecutionAttempt, ExecutionStatus, Receipt } from "./contracts.js";
import { hashPayload, idempotencyKey } from "./contracts.js";
import type { StageKv, StageRecord } from "./stage.js";

/**
 * The owning DO's exclusive-execution primitive: `ctx.blockConcurrencyWhile.bind(ctx)`. Generic
 * because `blockConcurrencyWhile` returns the block's value, and the journal uses that to hand
 * the locked outcome back.
 */
export type ExclusiveRunner = <T>(fn: () => Promise<T>) => Promise<T>;

export interface JournalOptions {
  kv: StageKv;
  runExclusive: ExclusiveRunner;
  gatekeeperId: string;
  /** Owning account identity. A lazy supplier defers env reads that may throw until first use. */
  accountId: string | (() => string);
  label: string;
}

/** What an executor reports after vendor I/O. Honest nulls are required, not fabricated IDs. */
export type ReceiptInput = {
  vendorId?: string | null;
  version?: string | null;
  beforeHash?: string | null;
  afterHash?: string | null;
  evidenceIds?: string[];
};

export type ExecutionOutcome =
  | { status: "succeeded"; attempt: ExecutionAttempt; idempotent: boolean }
  | { status: "failed"; attempt: ExecutionAttempt }
  | { status: "indeterminate"; attempt: ExecutionAttempt };

/** Read-back answer for reconciliation. "unknown" keeps the attempt indeterminate. */
export type VendorProbe = () => Promise<"applied" | "absent" | "unknown">;

/**
 * Thrown by an executor for a DEFINITIVE local refusal that happened before any vendor I/O
 * (policy gate, preflight ceiling, payload integrity). Absence of an external effect is
 * provable, so the attempt settles "failed" — unlike an arbitrary throw, which could have
 * occurred mid-vendor-call and must stay indeterminate.
 */
export class LocalRefusal extends Error {}

export interface ApprovedExecution<P> {
  ref: ActionRef;
  subject: ApprovalSubject;
  /** The durable record — the executor acts on this, never on the caller's arguments. */
  record: StageRecord<P>;
  writesEnabled: boolean;
  disabledMessage: string;
  execute: (record: StageRecord<P>, attempt: ExecutionAttempt) => Promise<ReceiptInput>;
  /** Bounded vendor read-back used to settle indeterminate attempts. */
  probe?: VendorProbe;
}

const ATTEMPT_PREFIX = "attempt:";
const LEASE_KEY = "counter:lease";

export class ExecutionJournal {
  readonly #kv: StageKv;
  readonly #runExclusive: ExclusiveRunner;
  readonly #gatekeeperId: string;
  readonly #accountId: string | (() => string);
  #leaseEpoch: number | null = null;

  constructor(options: JournalOptions) {
    this.#kv = options.kv;
    this.#runExclusive = options.runExclusive;
    this.#gatekeeperId = options.gatekeeperId;
    this.#accountId = options.accountId;
  }

  /** The owning account identity, resolving a lazy supplier on first use. */
  accountId(): string {
    return typeof this.#accountId === "function" ? this.#accountId() : this.#accountId;
  }

  /** This DO instance's exclusive epoch, claimed on first use. Increments across restarts. */
  async #currentLeaseEpoch(): Promise<number> {
    if (this.#leaseEpoch === null) {
      this.#leaseEpoch = ((await this.#kv.get<number>(LEASE_KEY)) ?? 0) + 1;
      await this.#kv.put(LEASE_KEY, this.#leaseEpoch);
    }
    return this.#leaseEpoch;
  }

  ref(actionId: number): ActionRef {
    return { gatekeeperId: this.#gatekeeperId, accountId: this.accountId(), actionId };
  }

  /** All persisted attempts for an action, oldest first. Attempts are immutable once terminal. */
  async attempts(actionId: number): Promise<ExecutionAttempt[]> {
    const found: ExecutionAttempt[] = [];
    for (const [, attempt] of this.#kv.list<ExecutionAttempt>({ prefix: `${ATTEMPT_PREFIX}${actionId}:` })) {
      found.push(attempt);
    }
    return found.toSorted((a, b) => a.number - b.number);
  }

  async latestAttempt(actionId: number): Promise<ExecutionAttempt | null> {
    const all = await this.attempts(actionId);
    return all.at(-1) ?? null;
  }

  /** The settled execution status: the last terminal attempt wins; else not-started/executing. */
  async status(actionId: number): Promise<ExecutionStatus> {
    const all = await this.attempts(actionId);
    for (let i = all.length - 1; i >= 0; i -= 1) {
      const s = all[i].status;
      if (s === "succeeded" || s === "failed" || s === "indeterminate" || s === "partial") return s;
    }
    return all.length ? "executing" : "not-started";
  }

  /**
   * Retires attempts left "executing" by an earlier DO lifetime. A vendor effect may exist; the
   * attempt becomes indeterminate and only reconciliation settles it. Runs inside an exclusive
   * block; call once per instance before any execution.
   */
  async recover(): Promise<void> {
    await this.#runExclusive(async () => {
      const epoch = await this.#currentLeaseEpoch();
      for (const [key, attempt] of this.#kv.list<ExecutionAttempt>({ prefix: ATTEMPT_PREFIX })) {
        if (attempt.status !== "executing" || attempt.leaseEpoch === epoch) continue;
        attempt.status = "indeterminate";
        attempt.errorCode = attempt.errorCode ?? "restart-left-executing";
        this.#kv.put(key, attempt);
      }
    });
  }

  /**
   * Runs an approved action's execution inside the DO's exclusive block: claims the attempt
   * (persisted before vendor I/O), runs the executor, settles a durable receipt — or records
   * indeterminate. Idempotent: settled success returns without dispatch; an indeterminate outcome
   * goes to the vendor probe, never to a blind retry.
   */
  async executeApproved<P>(execution: ApprovedExecution<P>): Promise<ExecutionOutcome> {
    return this.#runExclusive(async () => {
      const epoch = await this.#currentLeaseEpoch();
      return this.#executeLocked(execution, epoch);
    });
  }

  async #executeLocked<P>(execution: ApprovedExecution<P>, epoch: number): Promise<ExecutionOutcome> {
    const attempt = await this.latestAttempt(execution.ref.actionId);

    // Settled success is idempotent: redelivery reports the durable outcome without dispatch.
    if (attempt?.status === "succeeded") return { status: "succeeded", attempt, idempotent: true };

    // An indeterminate attempt may have a vendor effect. Only the probe settles it; a failed
    // probe (or its absence) leaves the attempt indeterminate. Never a blind retry.
    if (attempt?.status === "indeterminate" || attempt?.status === "partial") {
      if (!execution.probe) return { status: "indeterminate", attempt };
      const applied = await execution.probe();
      if (applied === "applied") {
        const settled = await this.#settle(attempt, execution, "succeeded", { evidenceIds: ["probe:applied"] });
        return { status: "succeeded", attempt: settled, idempotent: true };
      }
      if (applied === "absent") {
        const settled = await this.#settle(attempt, execution, "failed", null, "reconciled-absent");
        return { status: "failed", attempt: settled };
      }
      return { status: "indeterminate", attempt };
    }

    // No live attempt (or the previous one failed with no external effect): claim a new attempt.
    const number = attempt ? attempt.number + 1 : 1;
    const subject = execution.subject;
    const claimed: ExecutionAttempt = {
      ref: execution.ref,
      number,
      idempotencyKey: idempotencyKey(execution.ref, subject, number),
      leaseEpoch: epoch,
      status: "executing",
      receipt: null,
      errorCode: null,
    };
    // Persist the claim BEFORE vendor I/O.
    this.#kv.put(`${ATTEMPT_PREFIX}${execution.ref.actionId}:${number}`, claimed);

    // Operator gate: refuse before vendor I/O, leaving the claim failed with no external effect.
    if (!execution.writesEnabled) {
      const failed = await this.#settle(claimed, execution, "failed", null, "operator-disabled");
      return { status: "failed", attempt: failed };
    }

    try {
      const input = await execution.execute(execution.record, claimed);
      const settled = await this.#settle(claimed, execution, "succeeded", input);
      return { status: "succeeded", attempt: settled, idempotent: false };
    } catch (error) {
      if (error instanceof LocalRefusal) {
        // The refusal happened before vendor I/O: absence of an effect is provable, failed.
        const settled = await this.#settle(claimed, execution, "failed", null, error.message.slice(0, 200));
        return { status: "failed", attempt: settled };
      }
      // A thrown executor cannot establish absence of an external effect: indeterminate, not failed.
      const settled = await this.#settle(claimed, execution, "indeterminate", null, error instanceof Error ? error.message.slice(0, 200) : String(error));
      return { status: "indeterminate", attempt: settled };
    }
  }

  /**
   * Settles an attempt's terminal status and, for success, its durable receipt. Terminal attempts
   * are immutable: the record is rewritten once with the settled status and never revived.
   */
  async #settle<P>(
    attempt: ExecutionAttempt,
    execution: ApprovedExecution<P>,
    status: "succeeded" | "failed" | "indeterminate",
    input: ReceiptInput | null,
    errorCode?: string,
  ): Promise<ExecutionAttempt> {
    const key = `${ATTEMPT_PREFIX}${attempt.ref.actionId}:${attempt.number}`;
    const settled: ExecutionAttempt = { ...attempt, status, receipt: attempt.receipt, errorCode: errorCode ?? attempt.errorCode };
    if (status === "succeeded" && !settled.receipt) {
      const resultHash = await hashPayload(input ?? null);
      const receipt: Receipt = {
        ref: attempt.ref,
        subject: execution.subject,
        attempt: attempt.number,
        requestId: attempt.idempotencyKey,
        vendorId: input?.vendorId ?? null,
        version: input?.version ?? null,
        beforeHash: input?.beforeHash ?? null,
        afterHash: input?.afterHash ?? null,
        resultHash,
        recordedAt: Date.now(),
        evidenceIds: input?.evidenceIds ?? [],
      };
      settled.receipt = receipt;
    }
    this.#kv.put(key, settled);
    return settled;
  }

  /**
   * Migrates legacy records created before this journal existed.
   *
   *  - Old rejected records are terminal rejected; nothing is fabricated or reexecuted.
   *  - Old approved records become historical success with a receipt whose provenance is
   *    "legacy-receipt-unavailable" — vendorId stays null, no vendor receipt is fabricated, and
   *    the action is never reexecuted.
   *  - Open proposals without a bound payload hash require resubmission (flagged, refused at
   *    execution with a migration message).
   *  - Duplicate proposal ids across different action ids are quarantined for operator
   *    reconciliation; the newest action id stays live.
   */
  async migrateLegacy(stage: { get(actionId: number): Promise<Record<string, unknown> | undefined>; listAll(): Promise<Record<string, unknown>[]> }): Promise<LegacyMigration> {
    let rejectedTerminal = 0;
    let approvedHistorical = 0;
    let openRequireResubmission = 0;
    let quarantined = 0;

    for (const record of await stage.listAll()) {
      if (record.quarantined) { quarantined += 1; continue; }
      const actionId = record.actionId as number;
      if (record.state === "rejected") { rejectedTerminal += 1; continue; }
      if (record.state === "approved") {
        const attempts = await this.attempts(actionId);
        if (!attempts.some((a) => a.status === "succeeded")) {
          const ref = this.ref(actionId);
          const receipt: Receipt = {
            ref,
            subject: (record.subject as ApprovalSubject) ?? EMPTY_SUBJECT,
            attempt: 0,
            requestId: "legacy",
            vendorId: null,
            version: null,
            beforeHash: null,
            afterHash: null,
            resultHash: await hashPayload(record),
            recordedAt: Date.now(),
            evidenceIds: ["legacy-receipt-unavailable"],
          };
          this.#kv.put(`${ATTEMPT_PREFIX}${actionId}:0`, {
            ref, number: 0, idempotencyKey: "legacy", leaseEpoch: 0,
            status: "succeeded", receipt, errorCode: null,
          });
        }
        approvedHistorical += 1;
        continue;
      }
      if (record.state === "staged" || record.state === "pending") {
        // Legacy open proposals carry no bound approval subject/payload hash: they cannot be
        // executed. They are flagged for resubmission and refused at execution time.
        if (!record.subject) {
          record.requiresResubmission = true;
          openRequireResubmission += 1;
        }
      }
    }

    // Quarantine duplicate proposal ids: all but the newest action id move aside for operator
    // reconciliation. Stage listAll() orders live before retired; detect by proposalId.
    const byProposal = new Map<string, Record<string, unknown>[]>();
    for (const record of await stage.listAll()) {
      const p = record.proposalId as string | undefined;
      if (!p) continue;
      const group = byProposal.get(p) ?? [];
      group.push(record);
      byProposal.set(p, group);
    }
    for (const group of byProposal.values()) {
      if (group.length < 2) continue;
      const ids = group.map((r) => r.actionId as number).toSorted((a, b) => b - a);
      for (const id of ids.slice(0, -1)) {
        const record = group.find((r) => r.actionId === id);
        if (!record || record.quarantined) continue;
        record.quarantined = true;
        quarantined += 1;
      }
    }

    return { rejectedTerminal, approvedHistorical, openRequireResubmission, quarantined };
  }
}

export type LegacyMigration = {
  /** Legacy rejected records already terminal; unchanged. */
  rejectedTerminal: number;
  /** Legacy approved records given historical success receipts. */
  approvedHistorical: number;
  /** Legacy open proposals without approval hashes, flagged for resubmission. */
  openRequireResubmission: number;
  /** Duplicate-proposal records quarantined for operator reconciliation. */
  quarantined: number;
};

const EMPTY_SUBJECT: ApprovalSubject = {
  ownerId: "legacy", accountId: "legacy", workspaceId: "legacy",
  operation: "legacy", resource: "legacy", payloadHash: "legacy",
  policyVersion: "legacy", expiresAt: 0,
};
