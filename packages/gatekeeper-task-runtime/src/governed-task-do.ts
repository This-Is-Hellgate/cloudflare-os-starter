// GovernedTaskDO: the durable task capability (plan §4.2).
//
// The task runtime stores task policy and continuity; it has NO vendor secrets. Provider
// authority flows exclusively through grants minted here and enforced at the provider session.
// The model-facing TaskSession cannot append verified evidence, mint grants, or certify its own
// completion — those go through trusted internal paths only.

import { DurableObject, RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { hashPayload } from "@gadgets/stage";

import {
  deriveChildGrant, grantUsable,
} from "./authority.js";
import { migrate, TaskStorage, type SqlLike } from "./storage.js";
import type { ActionRef } from "@gadgets/stage";
import type {
  CheckpointRecord, ChildRecord, ChildResult, EvidenceRecord, EvidenceKind, Grant, TaskRecord,
  TaskSession, TaskStatus,
} from "./contracts.js";

/** Task limits: initial values; owner configuration may lower them, raising is a policy change. */
const DEFAULT_LIMITS = {
  maxRuns: 100,
  maxConcurrentChildren: 4,
  maxDepth: 2,
  maxCheckpointChars: 64 * 1_024,
  maxEvidenceInlineChars: 1_000_000,
  maxEvidenceTotalChars: 100 * 1_000_000,
};

const TASK_LIFETIME_MS = 24 * 60 * 60 * 1_000;

interface StoredTask {
  id: string; title: string; status: string; owner_id: string; workspace_id: string;
  created_at: number; expires_at: number; limits_json: string;
}

function rowToTask(row: StoredTask): TaskRecord {
  return {
    id: row.id, title: row.title, status: row.status as TaskStatus, ownerId: row.owner_id,
    workspaceId: row.workspace_id, createdAt: row.created_at, expiresAt: row.expires_at,
    limits: JSON.parse(row.limits_json),
  };
}

function grantFromRow(row: { id: string; binding: string; resource: string; methods_json: string; policy_version: string; expires_at: number; max_calls: number; max_writes: number; max_cost_microusd: number | null }): Grant {
  return {
    id: row.id, ownerId: "operator", workspaceId: "default", taskId: "", binding: row.binding,
    resource: row.resource, methods: JSON.parse(row.methods_json) as string[], policyVersion: row.policy_version,
    expiresAt: row.expires_at, maxCalls: row.max_calls, maxWrites: row.max_writes, maxCostMicrousd: row.max_cost_microusd,
  };
}

@validateRpc()
export class GovernedTaskDO extends DurableObject<Env> {
  readonly #sql: SqlLike;
  readonly #store: TaskStorage;
  #taskId: string;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // One task per DO instance: the DO id IS the task identity, so storage scopes naturally.
    this.#taskId = this.env.TASK_ID ?? this.ctx.id.toString();
    this.#sql = this.ctx.storage.sql as unknown as SqlLike;
    this.#store = new TaskStorage(this.#sql);
    // Migration runs on every entrypoint path; the constructor is the chokepoint every request
    // passes through (blockConcurrencyWhile semantics of the constructor).
    migrate(this.#sql);
    if (this.#store.getTask(this.#taskId) === undefined) {
      const limits = { ...DEFAULT_LIMITS, ...safeLimits(this.env) };
      this.#store.upsertTask({
        id: this.#taskId,
        title: this.env.TASK_TITLE ?? "governed task",
        status: "active",
        ownerId: this.env.TASK_OWNER ?? "operator",
        workspaceId: this.env.TASK_WORKSPACE ?? "default",
        createdAt: Date.now(),
        expiresAt: Date.now() + (this.env.TASK_LIFETIME_MS ? Math.min(Number(this.env.TASK_LIFETIME_MS), TASK_LIFETIME_MS) : TASK_LIFETIME_MS),
        limitsJson: JSON.stringify(limits),
      });
    }
  }

  // --- owner/admin surface (authenticated configuration; sessions cannot reach these) ---------

  /** Installs a grant version. Immutable history: each install is a new version row. */
  async installGrant(grant: Omit<Grant, "id">, installedBy: string): Promise<string> {
    const id = `grant:${this.#taskId}:${crypto.randomUUID().slice(0, 8)}`;
    this.#store.insertGrant({
      id, taskId: this.#taskId, ownerId: grant.ownerId, workspaceId: grant.workspaceId,
      binding: grant.binding, resource: grant.resource, methodsJson: JSON.stringify(grant.methods),
      policyVersion: grant.policyVersion, expiresAt: grant.expiresAt, maxCalls: grant.maxCalls,
      maxWrites: grant.maxWrites, maxCostMicrousd: grant.maxCostMicrousd, installedAt: Date.now(), installedBy,
    });
    return id;
  }

  async latestGrant(): Promise<Grant | undefined> {
    const grants = this.#store.grantsForTask(this.#taskId);
    const latest = grants.at(-1);
    return latest ? grantFromRow(latest) : undefined;
  }

  /** Links a settled Stage action into the task's action history. Trusted internal path. */
  async linkAction(ref: ActionRef): Promise<void> {
    this.#store.linkAction(this.#taskId, ref.gatekeeperId, ref.accountId, ref.actionId);
  }

  /** Appends VERIFIED evidence (provider observation/receipt). Trusted internal path only. */
  async appendVerifiedEvidence(kind: EvidenceKind, origin: string, content: string, resource: string | null, runId: string | null): Promise<EvidenceRecord> {
    const task = this.#store.getTask(this.#taskId);
    if (!task) throw new Error("Task not found.");
    const limits = JSON.parse(task.limits_json) as { maxEvidenceInlineChars: number };
    return appendEvidenceRecord(this.#store, this.#taskId, kind, origin, content, resource, runId, limits);
  }

  /** Records a settled child result. Trusted internal path only. */
  async recordChildResult(childTaskId: string, result: ChildResult): Promise<void> {
    const existing = this.#store.listChildren(this.#taskId).find((c) => c.child_task_id === childTaskId);
    if (!existing) throw new Error(`Unknown child task ${childTaskId}.`);
    this.#store.finishChild(childTaskId, JSON.stringify(result));
  }

  /** Derives the narrowed child grant (strict reduction) without installing it. */
  async deriveChild(requested: Pick<Grant, "binding" | "resource" | "methods" | "maxCalls" | "maxWrites" | "maxCostMicrousd" | "expiresAt">): Promise<{ ok: boolean; reason?: string; grant?: Grant }> {
    const parent = await this.latestGrant();
    if (!parent) return { ok: false, reason: "The parent task holds no grant to derive from." };
    if (!grantUsable(parent, Date.now())) return { ok: false, reason: "The parent grant has expired." };
    const verdict = deriveChildGrant(parent, requested, {
      childTaskId: `${this.#taskId}:child:${crypto.randomUUID().slice(0, 8)}`,
      policyVersion: parent.policyVersion, ownerId: parent.ownerId, workspaceId: parent.workspaceId, now: Date.now(),
    });
    return verdict.ok ? { ok: true, grant: verdict.child } : { ok: false, reason: verdict.reason };
  }

  async getBudgetState(): Promise<{ grant: Grant | undefined; usable: boolean }> {
    const grant = await this.latestGrant();
    return { grant, usable: grant !== undefined && grantUsable(grant, Date.now()) };
  }

  // --- agent-facing task session -------------------------------------------------------------

  async session(): Promise<TaskSessionStub> {
    return new TaskSessionStub(this.#store, this.#taskId, this);
  }
}

/** The agent-facing session: claims, checkpoints, reads — never verified evidence or grants. */
@validateRpc()
export class TaskSessionStub extends RpcTarget implements TaskSession {
  constructor(private readonly store: TaskStorage, private readonly taskId: string, private readonly owner: GovernedTaskDO) { super(); }

  async get(): Promise<TaskRecord> {
    const row = this.store.getTask(this.taskId);
    if (!row) throw new Error("Task not found.");
    return rowToTask(row);
  }

  /** Agent CLAIMS are evidence with origin "agent": they can never become receipts. */
  async appendClaim(text: string): Promise<EvidenceRecord> {
    if (typeof text !== "string" || !text.trim()) throw new Error("A claim requires content.");
    return this.owner.appendVerifiedEvidence("agent-claim", "agent", text.slice(0, 1_000_000), null, null);
  }

  async listEvidence(): Promise<EvidenceRecord[]> {
    return this.store.listEvidence(this.taskId).map((row) => ({
      id: row.id, taskId: this.taskId, runId: null, kind: row.kind as EvidenceKind,
      origin: row.origin, resource: null, observedAt: row.observed_at, contentHash: row.content_hash,
      content: null, ref: null,
    }));
  }

  async checkpoint(payload: string): Promise<CheckpointRecord> {
    if (typeof payload !== "string" || payload.length > 64 * 1_024) throw new Error("Checkpoint payload exceeds the 64 KiB bound.");
    this.store.checkpoint(this.taskId, `session:${Date.now()}`, payload);
    const latest = this.store.latestCheckpoint(this.taskId)!;
    return { taskId: this.taskId, runId: `session`, createdAt: latest.created_at, payload: latest.payload };
  }

  async listActions(): Promise<ActionRef[]> {
    return this.store.listActions(this.taskId).map((row) => ({ gatekeeperId: row.gatekeeper_id, accountId: row.account_id, actionId: row.action_id }));
  }

  /**
   * Requests completion. The runtime decides: a completion requires satisfied acceptance
   * criteria or an explicit owner override recorded as such — a model cannot certify its own
   * result by submitting a score.
   */
  async requestCompletion(summary: string): Promise<{ status: TaskStatus }> {
    if (typeof summary !== "string" || !summary.trim()) throw new Error("A completion request requires a summary.");
    // The claim is appended as an agent claim; the task moves to "evaluating" — an evaluator
    // (P8) or the owner confirms. Never "completed" directly from a model request.
    await this.owner.appendVerifiedEvidence("agent-claim", "agent", `requestCompletion: ${summary.slice(0, 10_000)}`, null, null);
    this.store.setTaskStatus(this.taskId, "evaluating");
    return { status: "evaluating" };
  }

  async fail(reason: string): Promise<{ status: TaskStatus }> {
    await this.owner.appendVerifiedEvidence("agent-claim", "agent", `fail: ${reason.slice(0, 10_000)}`, null, null);
    this.store.setTaskStatus(this.taskId, "failed");
    return { status: "failed" };
  }

  async listChildren(): Promise<ChildRecord[]> {
    return this.store.listChildren(this.taskId).map((row) => ({
      childTaskId: row.child_task_id, parentTaskId: this.taskId, grantId: row.grant_id,
      profile: row.profile, requestedAt: row.requested_at, finishedAt: row.finished_at ?? undefined,
      result: row.result_json ? (JSON.parse(row.result_json) as ChildResult) : undefined,
    }));
  }
}

/** Appends evidence with provenance; hashed at rest. Trusted-internal helper. */
export async function appendEvidenceRecord(store: TaskStorage, taskId: string, kind: EvidenceKind, origin: string, content: string, resource: string | null, runId: string | null, limits: { maxEvidenceInlineChars: number }): Promise<EvidenceRecord> {
  const id = `ev:${crypto.randomUUID().slice(0, 12)}`;
  const contentHash = await hashPayload(content);
  const inline = content.length <= limits.maxEvidenceInlineChars;
  const record = {
    id, taskId, runId, kind, origin, resource, observedAt: Date.now(), contentHash,
    content: inline ? content : null,
    ref: inline ? null : `r2://evidence/${taskId}/${id}`,
  };
  store.appendEvidence(record);
  return record;
}

function safeLimits(env: Env): Partial<typeof DEFAULT_LIMITS> {
  const out: Partial<typeof DEFAULT_LIMITS> = {};
  const read = (key: keyof typeof DEFAULT_LIMITS, envKey: string) => {
    const raw = (env as unknown as Record<string, string | undefined>)[envKey];
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) (out as Record<string, number>)[key] = n;
  };
  read("maxRuns", "TASK_MAX_RUNS");
  read("maxConcurrentChildren", "TASK_MAX_CHILDREN");
  read("maxDepth", "TASK_MAX_DEPTH");
  read("maxCheckpointChars", "TASK_MAX_CHECKPOINT_CHARS");
  read("maxEvidenceInlineChars", "TASK_MAX_EVIDENCE_CHARS");
  return out;
}

// Re-exports for the coordinator package.
export { SCHEMA_VERSION, migrate, TaskStorage } from "./storage.js";
export { deriveChildGrant, canReserve, grantUsable } from "./authority.js";
