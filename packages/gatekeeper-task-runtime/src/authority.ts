// Authority math for the task runtime — pure functions, unit-testable without storage.
//
// Invariants (plan §5.1):
//  - A child grant must be a STRICT REDUCTION of the parent's: fewer/equal calls, fewer/equal
//    writes, fewer/equal cost, expiring no later, scoped to the same binding+resource, and at
//    least one dimension strictly smaller. Equivalent or broader grants are refused.
//  - Aggregate concurrent reservations (held + retained) against a grant must stay within the
//    grant's ceilings. A reservation request that would exceed the ceiling is refused.
//  - Expiry is absolute: an expired grant refuses dispatch regardless of remaining budget.

import type { Grant } from "./contracts.js";

export type ReductionVerdict = { ok: true; child: Grant } | { ok: false; reason: string };

/**
 * Intersects the child's REQUESTED authority with the parent grant and the profile policy,
 * then proves strict reduction. The child gets what is left after the intersection — never
 * what was asked for beyond the parent.
 */
export function deriveChildGrant(
  parent: Grant,
  requested: Pick<Grant, "binding" | "resource" | "methods" | "maxCalls" | "maxWrites" | "maxCostMicrousd" | "expiresAt">,
  options: { childTaskId: string; policyVersion: string; ownerId: string; workspaceId: string; now: number },
): ReductionVerdict {
  if (requested.binding !== parent.binding) return { ok: false, reason: `Child binding ${requested.binding} does not match the parent grant's ${parent.binding}.` };
  if (requested.resource !== parent.resource) return { ok: false, reason: "Child resource does not match the parent grant's resource." };
  if (requested.expiresAt > parent.expiresAt) return { ok: false, reason: "Child expiry must not outlive the parent grant." };
  if (requested.expiresAt <= options.now) return { ok: false, reason: "Child expiry must be in the future." };

  const parentMethods = new Set(parent.methods);
  const methods = [...new Set(requested.methods)].filter((m) => parentMethods.has(m));
  if (!methods.length) return { ok: false, reason: "Child requested no methods within the parent grant." };

  const maxCalls = Math.min(requested.maxCalls, parent.maxCalls);
  const maxWrites = Math.min(requested.maxWrites, parent.maxWrites);
  const maxCostMicrousd = parent.maxCostMicrousd === null || requested.maxCostMicrousd === null
    ? (requested.maxCostMicrousd ?? parent.maxCostMicrousd)
    : Math.min(requested.maxCostMicrousd, parent.maxCostMicrousd);

  // Strict reduction: at least one dimension strictly smaller than the parent.
  const strictlySmaller =
    methods.length < parent.methods.length ||
    maxCalls < parent.maxCalls ||
    maxWrites < parent.maxWrites ||
    (maxCostMicrousd !== null && parent.maxCostMicrousd !== null && maxCostMicrousd < parent.maxCostMicrousd) ||
    requested.expiresAt < parent.expiresAt;
  if (!strictlySmaller) return { ok: false, reason: "Child authority must be strictly narrower than the parent's in at least one dimension." };

  return {
    ok: true,
    child: {
      id: `grant:${options.childTaskId}:${parent.id}`,
      ownerId: options.ownerId,
      workspaceId: options.workspaceId,
      taskId: options.childTaskId,
      binding: parent.binding,
      resource: parent.resource,
      methods,
      policyVersion: options.policyVersion,
      expiresAt: requested.expiresAt,
      maxCalls,
      maxWrites,
      maxCostMicrousd,
    },
  };
}

export interface BudgetState {
  heldCalls: number;
  heldWrites: number;
  heldCostMicrousd: number;
}

/** Refuses a reservation request that would push aggregate holds past the grant's ceilings. */
export function canReserve(
  grant: Pick<Grant, "maxCalls" | "maxWrites" | "maxCostMicrousd">,
  state: BudgetState,
  request: { calls: number; writes: number; costMicrousd: number | null },
): { ok: true } | { ok: false; reason: string } {
  if (state.heldCalls + request.calls > grant.maxCalls) {
    return { ok: false, reason: `Aggregate reserved calls (${state.heldCalls} held + ${request.calls} requested) would exceed the grant ceiling (${grant.maxCalls}).` };
  }
  if (state.heldWrites + request.writes > grant.maxWrites) {
    return { ok: false, reason: `Aggregate reserved writes would exceed the grant ceiling (${grant.maxWrites}).` };
  }
  if (grant.maxCostMicrousd !== null && request.costMicrousd !== null && state.heldCostMicrousd + request.costMicrousd > grant.maxCostMicrousd) {
    return { ok: false, reason: `Aggregate reserved cost would exceed the grant ceiling (${grant.maxCostMicrousd} microusd).` };
  }
  return { ok: true };
}

/** Absolute expiry: an expired grant refuses regardless of remaining budget. */
export function grantUsable(grant: Pick<Grant, "expiresAt">, now: number): boolean {
  return grant.expiresAt > now;
}
