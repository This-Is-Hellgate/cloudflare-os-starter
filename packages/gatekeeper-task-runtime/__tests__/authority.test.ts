import { describe, expect, it } from "vitest";
import { canReserve, deriveChildGrant, grantUsable } from "../src/authority.js";
import type { Grant } from "../src/contracts.js";

const parentGrant: Grant = {
  id: "grant:parent:1",
  ownerId: "operator",
  workspaceId: "ws",
  taskId: "task-1",
  binding: "SNOWFLAKE",
  resource: "APP.SALES.ORDERS",
  methods: ["query", "insert", "update", "merge"],
  policyVersion: "v1",
  expiresAt: 2_000_000,
  maxCalls: 100,
  maxWrites: 20,
  maxCostMicrousd: 5_000_000,
};

const base = { childTaskId: "task-child", policyVersion: "v1", ownerId: "operator", workspaceId: "ws", now: 1_000_000 };

describe("deriveChildGrant", () => {
  it("mints a strictly narrowed child grant", () => {
    const verdict = deriveChildGrant(parentGrant, {
      binding: "SNOWFLAKE", resource: "APP.SALES.ORDERS",
      methods: ["query", "insert"], maxCalls: 10, maxWrites: 5, maxCostMicrousd: 1_000_000, expiresAt: 1_500_000,
    }, base);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.child.methods).toEqual(["query", "insert"]);
      expect(verdict.child.maxCalls).toBe(10);
      expect(verdict.child.id).toContain("task-child");
    }
  });

  it("refuses equivalent-or-broader authority", () => {
    const same = deriveChildGrant(parentGrant, {
      binding: "SNOWFLAKE", resource: "APP.SALES.ORDERS",
      methods: [...parentGrant.methods], maxCalls: parentGrant.maxCalls, maxWrites: parentGrant.maxWrites, maxCostMicrousd: parentGrant.maxCostMicrousd, expiresAt: parentGrant.expiresAt,
    }, base);
    expect(same.ok).toBe(false);
    if (!same.ok) expect(same.reason).toMatch(/strictly narrower/);
  });

  it("refuses cross-binding, cross-resource, and outliving children", () => {
    expect(deriveChildGrant(parentGrant, { binding: "NVIDIA", resource: "APP.SALES.ORDERS", methods: ["query"], maxCalls: 5, maxWrites: 1, maxCostMicrousd: null, expiresAt: 1_500_000 }, base).ok).toBe(false);
    expect(deriveChildGrant(parentGrant, { binding: "SNOWFLAKE", resource: "OTHER.S.T", methods: ["query"], maxCalls: 5, maxWrites: 1, maxCostMicrousd: null, expiresAt: 1_500_000 }, base).ok).toBe(false);
    expect(deriveChildGrant(parentGrant, { binding: "SNOWFLAKE", resource: "APP.SALES.ORDERS", methods: ["query"], maxCalls: 5, maxWrites: 1, maxCostMicrousd: null, expiresAt: 2_500_000 }, base).ok).toBe(false);
  });

  it("drops requested methods outside the parent and refuses empty intersections", () => {
    const dropped = deriveChildGrant(parentGrant, {
      binding: "SNOWFLAKE", resource: "APP.SALES.ORDERS",
      methods: ["query", "delete", "admin"], maxCalls: 5, maxWrites: 1, maxCostMicrousd: null, expiresAt: 1_500_000,
    }, base);
    expect(dropped.ok).toBe(true);
    if (dropped.ok) expect(dropped.child.methods).toEqual(["query"]);
    const empty = deriveChildGrant(parentGrant, {
      binding: "SNOWFLAKE", resource: "APP.SALES.ORDERS",
      methods: ["delete"], maxCalls: 5, maxWrites: 1, maxCostMicrousd: null, expiresAt: 1_500_000,
    }, base);
    expect(empty.ok).toBe(false);
  });
});

describe("canReserve", () => {
  const grant = { maxCalls: 10, maxWrites: 4, maxCostMicrousd: 1_000_000 };

  it("permits holds within the aggregate ceilings", () => {
    expect(canReserve(grant, { heldCalls: 5, heldWrites: 2, heldCostMicrousd: 400_000 }, { calls: 3, writes: 1, costMicrousd: 100_000 })).toEqual({ ok: true });
  });

  it("refuses holds that would exceed any ceiling", () => {
    expect(canReserve(grant, { heldCalls: 9, heldWrites: 0, heldCostMicrousd: 0 }, { calls: 2, writes: 0, costMicrousd: null }).ok).toBe(false);
    expect(canReserve(grant, { heldCalls: 0, heldWrites: 4, heldCostMicrousd: 0 }, { calls: 1, writes: 1, costMicrousd: null }).ok).toBe(false);
    expect(canReserve(grant, { heldCalls: 0, heldWrites: 0, heldCostMicrousd: 900_000 }, { calls: 1, writes: 0, costMicrousd: 200_000 }).ok).toBe(false);
  });
});

describe("grantUsable", () => {
  it("is absolute expiry, budget notwithstanding", () => {
    expect(grantUsable({ expiresAt: 2_000_000 }, 1_999_999)).toBe(true);
    expect(grantUsable({ expiresAt: 2_000_000 }, 2_000_000)).toBe(false);
  });
});
