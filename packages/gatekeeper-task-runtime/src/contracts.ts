// Task-runtime contracts: the durable task capability surface shared between the runtime DO,
// the coordinator gadget, and governed callable agents.
//
// Design invariants (plan §4.2/§4.3):
//  - Grants are installed by authenticated owner/admin configuration; sessions cannot edit them.
//    A grant is immutable authority history: methods are explicit provider operations, never
//    `call(binding, arbitraryMethod, args)`.
//  - Reservations are conservative pre-dispatch holds against the parent's remaining budget;
//    aggregate concurrent reservations must not exceed the parent limit; ambiguous outcomes
//    retain their reservation until reconciled.
//  - Run admission is exactly-once per logical key (task + occurrence/callback id); delivery may
//    retry, the logical run does not duplicate.
//  - Children intersect requested authority with the parent's and require strict reduction.
//
// Cross-package types publish from here; the stage package remains the write-action authority.

import type { ActionRef } from "@gadgets/stage";

/** A workspace-scoped durable objective. */
export type TaskStatus = "active" | "waiting" | "waiting-approval" | "evaluating" | "completed" | "failed" | "cancelled";

/** One typed provider operation a grant may authorize. Family per the NVIDIA taxonomy. */
export type GrantMethod = string;

export interface Grant {
  id: string;
  ownerId: string;
  workspaceId: string;
  taskId: string;
  /** The provider binding this grant authorizes (e.g. "SNOWFLAKE", "NVIDIA"). */
  binding: string;
  /** The bound resource identity the grant scopes to (provider-specific canonical id). */
  resource: string;
  /** Explicit provider methods; never a generic call escape hatch. */
  methods: GrantMethod[];
  /** Policy version the grant was minted under; execution rechecks current policy. */
  policyVersion: string;
  /** Absolute expiry; expired grants refuse dispatch. */
  expiresAt: number;
  maxCalls: number;
  maxWrites: number;
  /** Microunits of USD; null when the provider has no trustworthy price source. */
  maxCostMicrousd: number | null;
}

/** A conservative pre-dispatch hold against a grant's remaining budget. */
export interface Reservation {
  id: string;
  runId: string;
  grantId: string;
  /**DO-lifetime epoch the reservation was minted under; recovery fences by it. */
  epoch: number;
  reservedCalls: number;
  reservedWrites: number;
  /** null when the provider's pricing is unknown: the reservation holds calls/writes only. */
  reservedCostMicrousd: number | null;
  status: "held" | "settled" | "released" | "retained";
}

/** Exactly-once admission of one logical run: task id + occurrence/callback event id. */
export interface RunAdmission {
  runId: string;
  epoch: number;
  disposition: "admitted" | "duplicate" | "denied";
  reason?: string;
}

/** What a governed child returns to its parent. Children cannot append authoritative receipts. */
export interface ChildResult {
  childTaskId: string;
  status: "completed" | "failed" | "cancelled";
  summary: string;
  evidenceIds: string[];
  actionRefs: ActionRef[];
}

/** The immutable record of one child the parent spawned. */
export interface ChildRecord {
  childTaskId: string;
  parentTaskId: string;
  /** The narrowed grant the child was minted under. */
  grantId: string;
  profile: string;
  /** Bounded wait: synchronous awaitChildren resolves within this window, then returns waiting. */
  requestedAt: number;
  finishedAt?: number;
  result?: ChildResult;
}

/** Evidence distinguishes verified provider observation from an agent claim (plan §4.3). */
export type EvidenceKind = "verified-observation" | "agent-claim" | "receipt" | "evaluation" | "checkpoint";

export interface EvidenceRecord {
  id: string;
  taskId: string;
  runId: string | null;
  kind: EvidenceKind;
  /** Where the content came from; provenance is part of the record, never an agent argument. */
  origin: string;
  resource: string | null;
  observedAt: number;
  contentHash: string;
  /** Bounded content lives here or in private evidence R2 when oversized. */
  content: string | null;
  /** R2 key when the content exceeded the inline ceiling. */
  ref: string | null;
}

export interface CheckpointRecord {
  taskId: string;
  runId: string;
  createdAt: number;
  /** Opaque continuation payload; ≤ 64 KiB inline. */
  payload: string;
}

/** Audit events are append-only and redactable-by-reference (plan P6.3 carries the operator view). */
export interface AuditEvent {
  id: string;
  taskId: string;
  runId: string | null;
  actionRef: ActionRef | null;
  attempt: number | null;
  policyVersion: string | null;
  payloadDigest: string | null;
  actor: string;
  kind: string;
  at: number;
}

/** A recurring/one-shot continuation registration mirrored from the Scheduler. */
export interface ScheduleRecord {
  taskId: string;
  /** Stable logical key: Scheduler registration id (persisted immediately at registration). */
  scheduleId: string;
  kind: "hook" | "calendar" | "interval";
  /** IANA timezone required for wall-clock scheduling; never defaulted silently. */
  timezone: string | null;
  awaitingEnablement: boolean;
  createdAt: number;
}

/** The operator-facing lifecycle surface of a task. */
export interface TaskRecord {
  id: string;
  title: string;
  status: TaskStatus;
  ownerId: string;
  workspaceId: string;
  createdAt: number;
  /** Default 24-hour lifetime; owner configuration may lower, never raise, limits. */
  expiresAt: number;
  limits: {
    maxRuns: number;
    maxConcurrentChildren: number;
    maxDepth: number;
    maxCheckpointChars: number;
    maxEvidenceInlineChars: number;
    maxEvidenceTotalChars: number;
  };
}

/** Task-session RPC surface (the typed facade the agent sees). */
export interface TaskSession {
  get(): Promise<TaskRecord>;
  /** Appends an agent CLAIM; verified evidence goes through trusted internal paths only. */
  appendClaim(text: string): Promise<EvidenceRecord>;
  listEvidence(): Promise<EvidenceRecord[]>;
  checkpoint(payload: string): Promise<CheckpointRecord>;
  listActions(): Promise<ActionRef[]>;
  /** Requests completion; acceptance criteria are evaluated by the runtime, not the model. */
  requestCompletion(summary: string): Promise<{ status: TaskStatus }>;
  fail(reason: string): Promise<{ status: TaskStatus }>;
  listChildren(): Promise<ChildRecord[]>;
}
