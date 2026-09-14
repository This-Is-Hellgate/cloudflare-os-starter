import { describe, expect, it } from "vitest";
import { GatedActions, proposeAction, Stage, type StageKv, type StageRecord } from "../src/index.js";

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
      return entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))[Symbol.iterator]();
    },
  };
}

function makeHarness() {
  const kv = fakeKv();
  const stage = new Stage<Payload>({ kv, label: "Test" });
  const gated = new GatedActions(stage, "Test");
  return { kv, stage, gated };
}

const payload = (n: number): Payload => ({ proposalId: `p-${n}`, operation: "insert", target: "DB.SCHEMA.T" });
const description = { title: "T", description: "d", implementsRevert: false };

describe("GatedActions.apply", () => {
  it("executes and records approval for a pending action", async () => {
    const { stage, gated, kv } = makeHarness();
    const actionId = await stage.stage(payload(1));
    await stage.markPending(actionId);
    let executed: StageRecord<Payload> | undefined;
    await gated.apply(actionId, { writesEnabled: true, disabledMessage: "no", execute: async (r) => { executed = r; } });
    expect(executed?.proposalId).toBe("p-1");
    expect((kv.get(`action:${actionId}`) as StageRecord<Payload>).state).toBe("approved");
    expect((kv.get(`action:${actionId}`) as StageRecord<Payload>).appliedAt).toEqual(expect.any(Number));
  });

  it("is idempotent on re-delivery of an already-approved action", async () => {
    const { stage, gated } = makeHarness();
    const actionId = await stage.stage(payload(1));
    await stage.markPending(actionId);
    let calls = 0;
    const execute = async () => { calls += 1; };
    await gated.apply(actionId, { writesEnabled: true, disabledMessage: "no", execute });
    await gated.apply(actionId, { writesEnabled: true, disabledMessage: "no", execute });
    expect(calls).toBe(1);
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

  it("fails closed behind the operator gate and leaves the record untouched", async () => {
    const { stage, gated, kv } = makeHarness();
    const actionId = await stage.stage(payload(1));
    await stage.markPending(actionId);
    let calls = 0;
    const execute = async () => { calls += 1; };
    await expect(gated.apply(actionId, { writesEnabled: false, disabledMessage: "executor is not enabled", execute }))
      .rejects.toThrow("executor is not enabled");
    expect(calls).toBe(0);
    expect((kv.get(`action:${actionId}`) as StageRecord<Payload>).state).toBe("pending");
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

  it("discards the staged record and propagates when the queue rejects the submission", async () => {
    const { stage, kv } = makeHarness();
    const sink = {
      stageAction: (p: Payload) => stage.stage(p),
      markActionPending: (id: number) => stage.markPending(id),
      discardStagedAction: (id: number) => stage.discardStaged(id),
    };
    await expect(proposeAction(sink, { submitAction: async () => { throw new Error("policy violation"); } }, payload(1), description))
      .rejects.toThrow("policy violation");
    // No orphaned action id lingers: the record never reached the queue, so it is gone.
    expect(await stage.findByProposalId("p-1")).toBeNull();
    expect(kv.get("action:1")).toBeUndefined();
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
