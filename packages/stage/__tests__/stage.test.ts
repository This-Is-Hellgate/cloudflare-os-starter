import { describe, expect, it } from "vitest";
import { Stage, type StageKv, type StageRecord } from "../src/index.js";

type Payload = { proposalId: string; operation: string; target: string };

// Map-backed fake of the SyncKvStorage surface Stage codes against. All methods are synchronous,
// matching ctx.storage.kv; the async wrappers in Stage simply await the plain values.
function fakeKv(): StageKv & { dump(): Map<string, unknown> } {
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
    dump(): Map<string, unknown> {
      return map;
    },
  };
}

function makeStage(kv: StageKv): Stage<Payload> {
  return new Stage<Payload>({ kv, label: "Test" });
}

const payload = (n: number): Payload => ({ proposalId: `p-${n}`, operation: "insert", target: "DB.SCHEMA.T" });

describe("Stage state machine", () => {
  it("allocates sequential action ids from a durable counter, not the clock", async () => {
    const kv = fakeKv();
    const stage = makeStage(kv);
    const first = await stage.stage(payload(1));
    const second = await stage.stage(payload(2));
    expect(first).toBe(1);
    expect(second).toBe(2);
    expect(kv.get("counter:action")).toBe(2);
    // The counter key itself is durable state, not a timestamp.
    expect(kv.get<number>("counter:action")).toEqual(expect.any(Number));
  });

  it("continues the sequence across Stage instances sharing storage", async () => {
    const kv = fakeKv();
    const a = await makeStage(kv).stage(payload(1));
    const b = await makeStage(kv).stage(payload(2));
    expect(b).toBe(a + 1);
  });

  it("creates records in an explicit staged state before submission", async () => {
    const stage = makeStage(fakeKv());
    const id = await stage.stage(payload(1));
    const record = await stage.get(id);
    expect(record).toMatchObject({ actionId: id, state: "staged", proposalId: "p-1", submittedAt: expect.any(Number) });
  });

  it("moves staged records to pending on markPending", async () => {
    const stage = makeStage(fakeKv());
    const id = await stage.stage(payload(1));
    await stage.markPending(id);
    expect((await stage.get(id))?.state).toBe("pending");
  });

  it("rejects with a vendor-labeled missing-record error", async () => {
    const stage = makeStage(fakeKv());
    await expect(stage.require(7)).rejects.toThrow("No queued Test action exists with id 7.");
  });

  it("discards only staged records, never submitted ones", async () => {
    const kv = fakeKv();
    const stage = makeStage(kv);
    const stagedId = await stage.stage(payload(1));
    const pendingId = await stage.stage(payload(2));
    await stage.markPending(pendingId);

    await stage.discardStaged(stagedId);
    await stage.discardStaged(pendingId);

    expect(await stage.get(stagedId)).toBeUndefined();
    expect((await stage.get(pendingId))?.state).toBe("pending");
  });

  it("retires rejected actions instead of deleting them", async () => {
    const kv = fakeKv();
    const stage = makeStage(kv);
    const id = await stage.stage(payload(1));
    await stage.markPending(id);

    const retired = await stage.reject(id);

    expect(retired.state).toBe("rejected");
    expect(retired.rejectedAt).toEqual(expect.any(Number));
    expect(kv.get(`action:${id}`)).toBeUndefined();
    expect(kv.get(`retiredAction:${id}`)).toBeDefined();
    // The record remains the durable evidence of the decision.
    expect(await stage.get(id)).toMatchObject({ state: "rejected", proposalId: "p-1" });
  });

  it("refuses to reject an action that is no longer pending", async () => {
    const stage = makeStage(fakeKv());
    const id = await stage.stage(payload(1));
    await stage.markPending(id);
    await stage.reject(id);
    await expect(stage.reject(id)).rejects.toThrow(`Test action ${id} is no longer pending.`);
  });

  it("marks approved actions with an appliedAt timestamp", async () => {
    const stage = makeStage(fakeKv());
    const id = await stage.stage(payload(1));
    await stage.markPending(id);
    const approved = await stage.markApproved(id);
    expect(approved.state).toBe("approved");
    expect(approved.appliedAt).toEqual(expect.any(Number));
  });

  it("resolves proposals across live and retired records", async () => {
    const stage = makeStage(fakeKv());
    const liveId = await stage.stage(payload(1));
    await stage.markPending(liveId);
    const retiredId = await stage.stage(payload(2));
    await stage.markPending(retiredId);
    await stage.reject(retiredId);

    expect(await stage.findByProposalId("p-1")).toMatchObject({ actionId: liveId, state: "pending" });
    expect(await stage.findByProposalId("p-2")).toMatchObject({ actionId: retiredId, state: "rejected" });
    expect(await stage.findByProposalId("missing")).toBeNull();
  });

  it("keeps the full vendor payload intact on the record", async () => {
    const stage = makeStage(fakeKv());
    const id = await stage.stage({ proposalId: "p-9", operation: "merge", target: "X.Y.Z" });
    const record: StageRecord<Payload> | undefined = await stage.get(id);
    expect(record).toMatchObject({ operation: "merge", target: "X.Y.Z", proposalId: "p-9" });
  });
});
