/**
 * Stage: the shared durable action ledger for Gatekeepers.
 *
 * A Stage owns the staged → pending → approved/rejected state machine that every consequential
 * action passes through before a vendor write executes. It is the durable, inspectable record of
 * what was proposed, in what state it currently sits, and (after rejection) the evidence that a
 * human decided against it.
 *
 * Invariants (each enforced here and covered by tests):
 *  1. Action ids are sequential, allocated from a durable counter — never from the clock.
 *  2. Every action is created in an explicit "staged" state before submission to the approval
 *     queue, so a crash between staging and submission leaves a discardable record rather than a
 *     half-registered action.
 *  3. Rejection retires rather than deletes: the record moves from `action:{id}` to
 *     `retiredAction:{id}` and remains the durable evidence of the decision.
 *  4. Lookups consult both live and retired records.
 *  5. discardStaged only deletes records still in "staged" — a record that already reached the
 *     approval queue is never silently dropped.
 *
 * Storage is injected as a minimal structural subset of DurableObjectStorage["kv"]
 * (SyncKvStorage): synchronous get/put/delete/list. The gatekeepers pass `this.ctx.storage.kv`
 * directly; tests use a Map-backed fake.
 */

/** The minimal storage surface Stage needs. Structurally satisfied by `ctx.storage.kv`. */
export interface StageKv {
  get<T = unknown>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): boolean;
  list<T = unknown>(options?: { prefix?: string }): Iterable<[string, T]>;
}

export type StageActionState = "staged" | "pending" | "approved" | "rejected";

/**
 * The durable record for a staged action: the vendor's own payload `P` (which must carry the
 * `proposalId` that sessions and overseers use to correlate) plus the ledger fields Stage owns.
 */
export type StageRecord<P> = P & {
  actionId: number;
  state: StageActionState;
  submittedAt: number;
  appliedAt?: number;
  rejectedAt?: number;
};

/** The vendor payload: everything except the ledger fields Stage itself assigns. */
export type StagePayload<P> = Omit<P, "actionId" | "state" | "submittedAt" | "appliedAt" | "rejectedAt">;

export interface StageOptions {
  /** Injected storage. Pass `this.ctx.storage.kv` from a Durable Object. */
  kv: StageKv;
  /**
   * Vendor label used in error messages, e.g. "Snowflake" produces
   * "No queued Snowflake action exists with id 3."
   */
  label: string;
}

const COUNTER_KEY = "counter:action";
const LIVE_PREFIX = "action:";
const RETIRED_PREFIX = "retiredAction:";

export class Stage<P extends { proposalId: string }> {
  readonly #kv: StageKv;
  readonly #label: string;

  constructor(options: StageOptions) {
    this.#kv = options.kv;
    this.#label = options.label;
  }

  /** Allocates the next sequential action id from the durable counter. */
  async #nextActionId(): Promise<number> {
    const value = ((await this.#kv.get<number>(COUNTER_KEY)) ?? 0) + 1;
    await this.#kv.put(COUNTER_KEY, value);
    return value;
  }

  /** Creates the durable record in the explicit "staged" state and returns its action id. */
  async stage(payload: StagePayload<P>): Promise<number> {
    const id = await this.#nextActionId();
    const record = { ...payload, actionId: id, state: "staged", submittedAt: Date.now() } as StageRecord<P>;
    await this.#kv.put(`${LIVE_PREFIX}${id}`, record);
    return id;
  }

  /** Moves a staged record to "pending" once it has been submitted to the approval queue. */
  async markPending(actionId: number): Promise<void> {
    const record = await this.require(actionId);
    record.state = "pending";
    await this.#kv.put(`${LIVE_PREFIX}${actionId}`, record);
  }

  /**
   * Drops a record that never reached the approval queue. Only "staged" records are discardable:
   * once submitted, the record belongs to the approval flow and must not vanish.
   */
  async discardStaged(actionId: number): Promise<void> {
    const record = await this.get(actionId);
    if (record?.state === "staged") await this.#kv.delete(`${LIVE_PREFIX}${actionId}`);
  }

  /**
   * Marks a pending or staged action rejected and retires it. The record is the durable evidence
   * that the proposal was rejected, so it is moved aside rather than deleted.
   */
  async reject(actionId: number): Promise<StageRecord<P>> {
    const record = await this.require(actionId);
    if (record.state !== "pending" && record.state !== "staged") {
      throw new Error(`${this.#label} action ${actionId} is no longer pending.`);
    }
    record.state = "rejected";
    record.rejectedAt = Date.now();
    await this.#kv.delete(`${LIVE_PREFIX}${actionId}`);
    await this.#kv.put(`${RETIRED_PREFIX}${actionId}`, record);
    return record;
  }

  /** Marks an action approved (the executor's durable completion record). */
  async markApproved(actionId: number): Promise<StageRecord<P>> {
    const record = await this.require(actionId);
    record.state = "approved";
    record.appliedAt = Date.now();
    await this.#kv.put(`${LIVE_PREFIX}${actionId}`, record);
    return record;
  }

  /** Looks up a record across live and retired storage. */
  async get(actionId: number): Promise<StageRecord<P> | undefined> {
    return (await this.#kv.get<StageRecord<P>>(`${LIVE_PREFIX}${actionId}`))
      ?? (await this.#kv.get<StageRecord<P>>(`${RETIRED_PREFIX}${actionId}`));
  }

  /** Like get, but throws the vendor-labeled missing-record error. */
  async require(actionId: number): Promise<StageRecord<P>> {
    const record = await this.get(actionId);
    if (!record) throw new Error(`No queued ${this.#label} action exists with id ${actionId}.`);
    return record;
  }

  /**
   * Finds the record for a proposal across live and retired storage. Live records win: if a
   * proposal id were ever reused, the current record is the one that matters.
   */
  async findByProposalId(proposalId: string): Promise<StageRecord<P> | null> {
    for (const record of await this.#listAll()) {
      if (record?.proposalId === proposalId) return record;
    }
    return null;
  }

  async #listAll(): Promise<StageRecord<P>[]> {
    const live: StageRecord<P>[] = [];
    for (const [, record] of await this.#kv.list<StageRecord<P>>({ prefix: LIVE_PREFIX })) live.push(record);
    const retired: StageRecord<P>[] = [];
    for (const [, record] of await this.#kv.list<StageRecord<P>>({ prefix: RETIRED_PREFIX })) retired.push(record);
    return [...live, ...retired];
  }
}
