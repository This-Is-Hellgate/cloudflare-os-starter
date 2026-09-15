import { describe, expect, it } from "vitest";
import {
  ExecutionJournal,
  GatedActions,
  proposeAction,
  Stage,
  type ApprovalSubject,
  type StageKv,
  type StageRecord,
} from "../src/index.js";

type Payload = { proposalId: string; operation: string; target: string };

// Same Map-backed SyncKvStorage fake the Stage tests use.
function fakeKv(): StageKv {
  const map = new Map<string, unknown>();
  return {
    get<T = unknown>(key: string): T | undefined {
      return map.get(key) as T | undefined;
    },
    put<T>(key: string, value: T): void {
      map.set(key, value);
    },
    delete(key: string): boolean {
      return map.delete(key);
    },
    list<T = unknown>(options?: { prefix?: string }): Iterable<[string, T]> {
      const entries: [string, T][] = [];
      for (const [k, v] of map) {
        if (!options?.prefix || k.startsWith(options.prefix)) entries.push([k, v as T]);
      }
      return entries.toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))[Symbol.iterator]();
    },
  };
}

function makeHarness() {
  const kv = fakeKv();
  const stage = new Stage<Payload>({ kv, label: "Test" });
  // Single-threaded fake: the real DO satisfies runExclusive with ctx.blockConcurrencyWhile,
  // which serializes exactly what this identity runner serializes in a single-threaded test.
  const journal = new ExecutionJournal({
    kv,
    runExclusive: (fn) => fn(),
    gatekeeperId: "test",
    accountId: "acct-1",
    label: "Test",
  });
  const gated = new GatedActions(stage, "Test", journal);
  return { kv, stage, gated, journal };
}

const subject: ApprovalSubject = {
  ownerId: "owner-1",
  accountId: "acct-1",
  workspaceId: "ws-1",
  operation: "insert",
  resource: "DB.SCHEMA.T",
  payloadHash: "bound-at-staging",
  policyVersion: "v1",
  expiresAt: Date.now() + 60_000,
};

/** apply() options for `actionId`: trusted subject + ref plus per-test executor overrides. */
function applyOptions(
  journal: ExecutionJournal,
  actionId: number,
  overrides: Partial<Parameters<GatedActions<Payload>["apply"]>[1]> = {},
): Parameters<GatedActions<Payload>["apply"]>[1] {
  return {
    writesEnabled: true,
    disabledMessage: "no",
    subject,
    ref: journal.ref(actionId),
    execute: async () => ({}),
    ...overrides,
  };
}

const payload = (n: number): Payload => ({ proposalId: `p-${n}`, operation: "insert", target: "DB.SCHEMA.T" });
const description = { title: "T", description: "d", implementsRevert: false };

describe("GatedActions.apply", () => {
  it("executes and records approval for a pending action", async () => {
    const { stage, gated, journal } = makeHarness();
    const actionId = await stage.stage(payload(1));
    await stage.markPending(actionId);
    let executed: StageRecord<Payload> | undefined;
    const outcome = await gated.apply(actionId, applyOptions(journal, actionId, { execute: async (r) => { executed = r; } }));
    expect(outcome.status).toBe("succeeded");
    expect(executed?.proposalId).toBe("p-1");
    // Decision recorded: terminal approved, retired from live storage.
    expect((await stage.get(actionId))?.state).toBe("approved");
    expect((await stage.get(actionId))?.appliedAt).toEqual(expect.any(Number));
    // Execution journaled separately: durable attempt + receipt with honest vendor nulls.
    expect(await journal.status(actionId)).toBe("succeeded");
    const attempt = await journal.latestAttempt(actionId);
    expect(attempt?.receipt?.vendorId).toBeNull();
    expect(attempt?.receipt?.requestId).toBe(attempt?.idempotencyKey);
  });

  it("is idempotent on re-delivery of an already-approved action", async () => {
    const { stage, gated, journal } = makeHarness();
    const actionId = await stage.stage(payload(1));
    await stage.markPending(actionId);
    let calls = 0;
    const execute = async () => { calls += 1; return {}; };
    const first = await gated.apply(actionId, applyOptions(journal, actionId, { execute }));
    const second = await gated.apply(actionId, applyOptions(journal, actionId, { execute }));
    expect(calls).toBe(1);
    expect(first.idempotent).toBe(false);
    // Redelivery reports the settled durable outcome without dispatching again.
    expect(second.status).toBe("succeeded");
    expect(second.idempotent).toBe(true);
  });

  it("refuses to apply a rejected (retired) action", async () => {
    const { stage, gated } = makeHarness();
    const actionId = await stage.stage(payload(1));
    await stage.markPending(actionId);
    await stage.reject(actionId);
    await expect(gated.apply(actionId, { writesEnabled: true, disabledMessage: "no", execute: async () => {} }))
      .rejects.toThrow("Test action 1 is no longer pending.");
  });

  it("refuses to apply a missing action", async () => {
    const { gated } = makeHarness();
    await expect(gated.apply(9, { writesEnabled: true, disabledMessage: "no", execute: async () => {} }))
      .rejects.toThrow("No queued Test action exists with id 9.");
  });

  it("fails closed behind the operator gate: no dispatch, failed attempt, decision recorded", async () => {
    const { stage, gated, journal } = makeHarness();
    const actionId = await stage.stage(payload(1));
    await stage.markPending(actionId);
    let calls = 0;
    const execute = async () => { calls += 1; return {}; };
    const outcome = await gated.apply(actionId, applyOptions(journal, actionId, { writesEnabled: false, disabledMessage: "executor is not enabled", execute }));
    expect(calls).toBe(0);
    // Decision and execution are separate: the trusted approval is recorded, but "approved"
    // is never a synonym for success — the execution attempt failed and says so.
    expect(outcome.status).toBe("failed");
    expect(outcome.attempt.errorCode).toBe("operator-disabled");
    expect(await journal.status(actionId)).toBe("failed");
    expect((await stage.get(actionId))?.state).toBe("approved");
  });
});

describe("proposeAction", () => {
  it("stages, submits, and marks pending", async () => {
    const { stage, kv } = makeHarness();
    const submitted: Array<{ actionId: number; description: unknown }> = [];
    const sink = {
      stageAction: (p: Payload) => stage.stage(p),
      markActionPending: (id: number) => stage.markPending(id),
      discardStagedAction: (id: number) => stage.discardStaged(id),
    };
    const result = await proposeAction(sink, { submitAction: async (id, d) => { submitted.push({ actionId: id, description: d }); } }, payload(1), description);
    expect(result).toEqual({ proposalId: "p-1", actionId: 1 });
    expect(submitted).toEqual([{ actionId: 1, description }]);
    expect((kv.get("action:1") as StageRecord<Payload>).state).toBe("pending");
  });

  it("retains the pending record for reconciliation when the queue rejects the submission", async () => {
    const { stage, kv } = makeHarness();
    const sink = {
      stageAction: (p: Payload) => stage.stage(p),
      markActionPending: (id: number) => stage.markPending(id),
      discardStagedAction: (id: number) => stage.discardStaged(id),
    };
    await expect(proposeAction(sink, { submitAction: async () => { throw new Error("policy violation"); } }, payload(1), description))
      .rejects.toThrow("policy violation");
    // Delivery outcome is unknown: the queue may own the action even though the call threw,
    // and an auto-approved callback can arrive after submitAction() fails. The record is
    // retained as pending for reconciliation — never deleted behind the queue's back.
    expect((await stage.findByProposalId("p-1"))?.state).toBe("pending");
    expect(kv.get("action:1")).toBeDefined();
  });

  it("does not discard a record that already reached the queue", async () => {
    const { stage, kv } = makeHarness();
    const sink = {
      stageAction: (p: Payload) => stage.stage(p),
      markActionPending: (id: number) => stage.markPending(id),
      discardStagedAction: (id: number) => stage.discardStaged(id),
    };
    // Simulate a failure after submission by marking pending inside submitAction, then throwing.
    const submitter = { submitAction: async (id: number) => { await stage.markPending(id); throw new Error("transport"); } };
    await expect(proposeAction(sink, submitter, payload(1), description)).rejects.toThrow("transport");
    expect((kv.get("action:1") as StageRecord<Payload>).state).toBe("pending");
  });
});
