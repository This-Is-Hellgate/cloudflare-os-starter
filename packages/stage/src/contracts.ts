// Separate decision/execution records: an approval decision is made once, through the owning
// upstream approval capability; execution is a distinct journaled process with attempts, receipts,
// and recovery. "Approved" is never a synonym for "successfully applied", and terminal decisions
// cannot be revived.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Identifies the queued action. Upstream action IDs are sequential integers; account scoping is preserved end to end. */
export type ActionRef = {
  gatekeeperId: string;
  accountId: string;
  actionId: number;
};

/**
 * Who/what the approval is bound to. Every field comes from trusted session/account context, not
 * model claims. The subject is fixed before submission and rechecked at execution time.
 */
export type ApprovalSubject = {
  ownerId: string;
  accountId: string;
  workspaceId: string;
  /** Free-form normalized operation label, e.g. "insert" or "create_commit". */
  operation: string;
  /** Normalized target label, e.g. a qualified table name or repository path. */
  resource: string;
  /** Digest of the exact normalized payload, bound before approval submission. */
  payloadHash: string;
  /** The policy version that approved the proposal. Rechecked at execution time. */
  policyVersion: string;
  /** Epoch ms after which the decision is expired and execution refuses to run. */
  expiresAt: number;
};

/** One-way decision lifecycle. Rejection/expiration are also allowed before submission completes. */
export type Decision = "staged" | "pending" | "approved" | "rejected" | "expired";

/** Execution is separate from decision. "indeterminate" means a vendor effect may exist. */
export type ExecutionStatus =
  | "not-started"
  | "executing"
  | "succeeded"
  | "failed"
  | "indeterminate"
  | "partial";

/**
 * Durable completion evidence. Use the vendor's real request/commit/statement/version identifier
 * when available. If unavailable, `vendorId` stays null and the receipt must carry a bounded
 * read-back evidence reference (`evidenceIds`); a local random ID must not masquerade as a vendor
 * receipt.
 */
export type Receipt = {
  ref: ActionRef;
  subject: ApprovalSubject;
  attempt: number;
  /** Key a vendor can reconcile by, generated before vendor I/O and reused on retry. */
  requestId: string;
  vendorId: string | null;
  version: string | null;
  beforeHash: string | null;
  afterHash: string | null;
  resultHash: string;
  recordedAt: number;
  evidenceIds: string[];
};

/** An immutable, persisted-before-I/O execution attempt. Never recreated for the same attempt number. */
export type ExecutionAttempt = {
  ref: ActionRef;
  number: number;
  idempotencyKey: string;
  /** DO lease epoch that claimed the attempt; fences local completion after restart. */
  leaseEpoch: number;
  status: ExecutionStatus;
  receipt: Receipt | null;
  errorCode: string | null;
};

/** Provenance of how an approval signal was obtained. Only the owning upstream capability may supply it. */
export type ApprovalProvenance =
  | { via: "overseer"; recordedAt: number }
  | { via: "legacy-receipt-unavailable"; recordedAt: number };

/** Stable canonical JSON serialization for payload hashing. Object keys are sorted; arrays keep order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).filter((k) => (value as Record<string, unknown>)[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  throw new TypeError(`Payload value is not JSON-serializable: ${typeof value}`);
}

/** Digest of the exact normalized payload, via the runtime's Web Crypto. Async because hashing is. */
export async function hashPayload(value: unknown): Promise<string> {
  const data = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The key vendors reconcile by, minted before vendor I/O and reused unchanged on every attempt retry. */
export function idempotencyKey(ref: ActionRef, subject: ApprovalSubject, attempt: number): string {
  return canonicalJson({ actionId: ref.actionId, accountId: ref.accountId, payloadHash: subject.payloadHash, attempt });
}

/** True when the decision is expired at the given epoch ms. */
export function isExpired(subject: ApprovalSubject, now: number): boolean {
  return subject.expiresAt <= now;
}
