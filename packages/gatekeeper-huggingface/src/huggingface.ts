import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type { AccountDescription, ApprovalQueue, Gatekeeper, GatekeeperConnectCallback, GatekeeperConnectOptions, GatekeeperUser, GatekeeperUserVerifier, ResourceConfiguratorFrame, ResourceDescription, SupportedResource, VendorDescription } from "@gadgets/workshop-shared/gatekeeper";
import type { CommitFileChange, DatasetPage, DatasetQueryOptions, DatasetQueryPages, DatasetQueryResult, DiscussionSummary, HuggingFaceCursor, HuggingFaceDatasetInfo, HuggingFaceDiscussionDetail, HuggingFaceFilePage, HuggingFaceModelCard, HuggingFaceRepository, HuggingFaceSession, HuggingFaceSpaceInfo, InferenceRequest, InferenceResult, InferenceTarget, WriteProposal } from "./types.js";
import TYPES_CODE from "./types-code.js";
import { Stage, GatedActions, ExecutionJournal, proposeAction, type StageRecord } from "@gadgets/stage";
import type { ActionRef, ApprovalSubject, ExecutionAttempt, ReceiptInput } from "@gadgets/stage";
import { LivePageSource, offsetPaged, type LivePage } from "@gadgets/cursor";
import { capOutput, fitRowsToByteBudget, streamTextCapped } from "./limits.js";
import {
  NDJSON_CONTENT_TYPE,
  buildCommitNdjson,
  extractCommitOid,
  probeCommit,
  validateCommit,
  validateRevision,
  type CommitChange,
  type CommitFileHash,
} from "./ndjson.js";

const ICON = { url: "https://huggingface.co/front/assets/huggingface_logo-noborder.svg" };
const RESOURCES: SupportedResource[] = [
  { urlPattern: "https://huggingface.co/models/*", title: "Hugging Face model", description: "A scoped model repository and its bounded inference target.", grantable: true },
  { urlPattern: "https://huggingface.co/datasets/*", title: "Hugging Face dataset", description: "A scoped dataset repository and bounded query surface.", grantable: true },
  { urlPattern: "https://huggingface.co/spaces/*", title: "Hugging Face Space", description: "A scoped Space repository and controlled lifecycle actions.", grantable: true },
];

type Resource = HuggingFaceRepository & { kind: "model" | "dataset" | "space" };
type GatekeeperProps = { resourceUrl?: string };
type Queue = Pick<ApprovalQueue, "authorizeObservation" | "submitAction"> & Partial<{ [Symbol.dispose](): void }>;
type HuggingFaceWriteAction = { proposalId: string; operation: WriteProposal["operation"]; summary: string; data: unknown };
type StoredHuggingFaceAction = StageRecord<HuggingFaceWriteAction>;
/** The durable payload of a create_commit action: everything bound at approval time. */
type StoredCommitPayload = {
  message: string;
  changes: CommitChange[];
  revision?: string;
  parentCommit?: string;
  fileHashes?: CommitFileHash[];
};

function parseResource(raw: string | undefined): Resource {
  if (!raw) throw new Error("HF_RESOURCE_URL is required for a Hugging Face binding.");
  const url = new URL(raw);
  if (url.origin !== "https://huggingface.co") throw new Error("Hugging Face resource must use huggingface.co.");
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 3 || !["models", "datasets", "spaces"].includes(parts[0])) throw new Error("Resource must be https://huggingface.co/{models|datasets|spaces}/{namespace}/{repo}.");
  const id = `${parts[1]}/${parts[2]}`;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(id)) throw new Error("Invalid Hugging Face repository identifier.");
  return { id, kind: parts[0] === "models" ? "model" : parts[0] === "datasets" ? "dataset" : "space", private: false };
}

function apiPath(resource: Resource, suffix = ""): string { return `https://huggingface.co/api/${resource.kind === "model" ? "models" : resource.kind === "dataset" ? "datasets" : "spaces"}/${encodeURIComponent(resource.id).replaceAll("%2F", "/")}${suffix}`; }
function boundedString(value: string, max: number, name: string): string { if (value.length > max) throw new Error(`${name} exceeds the ${max}-character limit.`); return value; }
function boundedInt(value: number | undefined, fallback: number, max: number): number { const n = value ?? fallback; if (!Number.isInteger(n) || n < 1 || n > max) throw new Error("Requested limit is outside the allowed bound."); return n; }
function writesEnabled(env: Env): boolean { return env.HF_ENABLE_WRITES === "true" || env.HF_ENABLE_WRITES === "1"; }


class HubClient {
  constructor(private readonly token: string) { if (!token) throw new Error("Hugging Face credentials are not configured."); }
  #headers(extra?: HeadersInit): Headers {
    const headers = new Headers(extra);
    headers.set("Authorization", `Bearer ${this.token}`);
    headers.set("Accept", "application/json");
    return headers;
  }
  async request(url: string, init: RequestInit = {}): Promise<any> {
    const response = await fetch(url, { ...init, headers: this.#headers(init.headers), signal: AbortSignal.timeout(30_000) });
    if (!response.ok) { if ([401, 403, 404].includes(response.status)) throw new Error(`Hugging Face resource is not accessible (${response.status}).`); throw new Error(`Hugging Face request failed (${response.status}).`); }
    return response.headers.get("content-type")?.includes("json") ? response.json() : response.text();
  }

  /**
   * Streams a text response with a HARD byte ceiling: reading stops (the stream is cancelled)
   * once the cap is crossed, so an oversized file is never fully buffered. The bound mechanics
   * are the tested pure helper in limits.ts.
   */
  async readTextCapped(url: string, maxBytes: number): Promise<string> {
    const response = await fetch(url, { headers: this.#headers(), signal: AbortSignal.timeout(30_000) });
    if (!response.ok) { if ([401, 403, 404].includes(response.status)) throw new Error(`Hugging Face resource is not accessible (${response.status}).`); throw new Error(`Hugging Face request failed (${response.status}).`); }
    return streamTextCapped(response, maxBytes);
  }
}

/**
 * The RPC surface of a live cursor capability. The walk mechanics — page budget, idempotent
 * exhaustion, close, in-flight guard — live in @gadgets/cursor; this class is the thin transformed
 * RpcTarget that hands them to the agent. The source is minted inside the governed session flow,
 * so the capability it yields stays bound to that flow's resource identity and budgets.
 */
@validateRpc()
class HubCursor<T> extends RpcTarget {
  constructor(private readonly source: LivePageSource<T>) { super(); }
  next(): Promise<T[] | null> { return this.source.next(); }
  // Deterministic resource release: disposing the capability ends its lifetime (later walks
  // refuse), whether the agent finished, timed out, or was cancelled.
  [Symbol.dispose](): void { this.source.close(); }
}

/** Verified datasets-server paging constants: rows are fetched in windows of at most 100. */
const DATASET_PAGE_ROWS = 100;

/**
 * Resolve the config/split pair: explicit options win, otherwise the first queryable split
 * advertised by the approved datasets-server backend. Shared by both dataset query forms.
 */
async function resolveDatasetSplit(
  client: HubClient,
  resource: Resource,
  options?: DatasetQueryOptions,
): Promise<{ config: string; split: string }> {
  let cfg = options?.config ? boundedString(options.config, 200, "config") : undefined;
  let spl = options?.split ? boundedString(options.split, 200, "split") : undefined;
  if (!cfg || !spl) {
    const splits = await client.request(`https://datasets-server.huggingface.co/splits?dataset=${encodeURIComponent(resource.id)}`);
    const first = Array.isArray((splits as any)?.splits) ? (splits as any).splits[0] : undefined;
    cfg = cfg ?? (first?.config !== undefined ? String(first.config).slice(0, 200) : undefined);
    spl = spl ?? (first?.split !== undefined ? String(first.split).slice(0, 200) : undefined);
  }
  if (!cfg || !spl) throw new Error("Dataset has no queryable splits.");
  return { config: cfg, split: spl };
}

/**
 * The RPC surface of the dataset paging capability. Delegates walk mechanics to @gadgets/cursor;
 * carries the resource's identity (columns, total) back to the agent through the minting closures.
 */
@validateRpc()
class DatasetPagesCursor extends RpcTarget implements DatasetQueryPages {
  constructor(
    private readonly source: LivePageSource<DatasetPage>,
    private readonly columns: () => string[],
    private readonly totalRows: () => number,
  ) { super(); }
  next(): Promise<DatasetPage | null> { return this.source.next().then((pages) => pages?.[0] ?? null); }
  getColumns(): Promise<string[]> { return Promise.resolve(this.columns()); }
  getTotalRows(): Promise<number> { return Promise.resolve(this.totalRows()); }
  [Symbol.dispose](): void { this.source.close(); }
}

@validateRpc()
export class HuggingFaceGatekeeper extends DurableObject<Env, GatekeeperProps> implements Gatekeeper<HuggingFaceSession> {
  readonly #stage = new Stage<HuggingFaceWriteAction>({ kv: this.ctx.storage.kv, label: "Hugging Face" });
  readonly #journal = new ExecutionJournal({
    kv: this.ctx.storage.kv,
    // The DO's real exclusive-execution primitive: while a block runs, every other event queues.
    runExclusive: this.ctx.blockConcurrencyWhile.bind(this.ctx),
    gatekeeperId: "huggingface",
    // Lazy: defers the env read (which throws when unset) until first journal use.
    accountId: () => parseResource(this.#url()).id,
    label: "Hugging Face",
  });
  readonly #gated = new GatedActions(this.#stage, "Hugging Face", this.#journal);

  #url(): string | undefined { return this.ctx.props?.resourceUrl ?? this.env.HF_RESOURCE_URL; }
  async describe(): Promise<ResourceDescription> { const r = parseResource(this.#url()); return { url: `https://huggingface.co/${r.kind === "model" ? "models" : r.kind === "dataset" ? "datasets" : "spaces"}/${r.id}`, title: `Hugging Face ${r.kind}`, snippet: `Scoped ${r.kind} repository capability`, suggestedBindingName: `HUGGINGFACE_${r.kind.toUpperCase()}`, tsType: "HuggingFaceSession" }; }
  async getTypeScriptTypes(): Promise<string> { return TYPES_CODE; }
  async getAutoApprovableActions(): Promise<[]> { return []; }
  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<HuggingFaceSession> { return new HuggingFaceSessionImpl(approvalQueue.dup(), this.env, this, this.#url()); }
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> { throw new Error("Hugging Face bindings require tracked observer verification before sharing."); }
  async removeObserver(_id: string): Promise<void> {}

  /**
   * The trusted approval subject for an action, rebuilt from this DO's environment and bound
   * resource scope — never from session-visible arguments. Expiry is bound at proposal time.
   */
  async #trustedSubject(operation: string, resource: string, expiresAt: number): Promise<ApprovalSubject> {
    const r = parseResource(this.#url());
    const policyVersion = await (await import("@gadgets/stage")).hashPayload({ kind: r.kind, id: r.id, writes: writesEnabled(this.env) });
    return {
      ownerId: "operator",
      accountId: r.id,
      workspaceId: "default",
      operation,
      resource,
      payloadHash: "",
      policyVersion,
      expiresAt,
    };
  }

  async applyAction(actionId: number): Promise<void> {
    // Decision + execution are separate. The record's bound subject carries the proposal-time
    // scope; the gate rechecks this DO's current trusted context and expiry before vendor I/O.
    const record = await this.#stage.require(actionId);
    const bound = record.subject;
    const subject = await this.#trustedSubject(record.operation, parseResource(this.#url()).id, bound?.expiresAt ?? 0);
    const ref: ActionRef = this.#journal.ref(actionId);
    // Reconciliation probe for an uncertain commit: compare the revision's HEAD against the
    // parent commit and the submitted summary. Without that evidence the outcome stays
    // indeterminate — the Hub has no idempotency key, so never a blind retry.
    const probe = record.operation === "create_commit"
      ? async (): Promise<"applied" | "absent" | "unknown"> => {
          const stored = record.data as StoredCommitPayload;
          const client = new HubClient(this.env.HF_TOKEN);
          return probeCommit((url) => client.request(url), apiPath(parseResource(this.#url())), {
            revision: validateRevision(stored?.revision),
            summary: (stored?.message ?? "").slice(0, 200),
            parentCommit: stored?.parentCommit,
          });
        }
      : async (): Promise<"applied" | "absent" | "unknown"> => "unknown";
    const outcome = await this.#gated.apply(actionId, {
      writesEnabled: writesEnabled(this.env),
      disabledMessage: "Hugging Face write application is disabled until the action executor is enabled.",
      subject,
      ref,
      execute: (stored, attempt) => this.#execute(stored, attempt),
      probe,
    });
    if (outcome.status === "indeterminate") {
      throw new Error(`Hugging Face action ${actionId} is indeterminate: a vendor effect may exist; reconcile by key ${outcome.attempt.idempotencyKey}.`);
    }
    if (outcome.status === "failed") {
      throw new Error(`Hugging Face action ${actionId} failed: ${outcome.attempt.errorCode ?? "unknown error"}.`);
    }
  }

  // The executor runs only behind an explicit operator gate (HF_ENABLE_WRITES) and after the
  // overseer's trusted decision; the journal's attempt claim and receipt are the durable
  // completion evidence. Each branch reports the vendor's REAL identifiers when the response
  // carries them, and honest nulls when it does not.
  async #execute(record: StoredHuggingFaceAction, _attempt: ExecutionAttempt): Promise<ReceiptInput> {
    const client = new HubClient(this.env.HF_TOKEN);
    const r = parseResource(this.#url());
    switch (record.operation) {
      case "create_commit": {
        const stored = record.data as StoredCommitPayload;
        // Re-validate the STORED payload through the same V1 protocol validator the proposal
        // used — the durable record is what executes, never session arguments.
        const commit = await validateCommit({ message: stored.message, changes: stored.changes, revision: stored.revision, parentCommit: stored.parentCommit });
        // The content hashes bound at approval must still match the stored content: a mismatch
        // means the record was corrupted after approval, and the write refuses.
        if (Array.isArray(stored.fileHashes)) {
          const intact = commit.hashes.length === stored.fileHashes.length
            && commit.hashes.every((h, i) => h.path === stored.fileHashes?.[i]?.path && h.sha256 === stored.fileHashes?.[i]?.sha256);
          if (!intact) throw new Error("Stored commit content does not match the approved payload hashes.");
        }
        // Official protocol: newline-delimited header/file/deletedFile records.
        const response = await client.request(apiPath(r, `/commit/${encodeURIComponent(commit.revision)}`), {
          method: "POST",
          headers: { "Content-Type": NDJSON_CONTENT_TYPE },
          body: buildCommitNdjson(commit.records),
        });
        // The returned commit OID is the only accepted proof of the write; without it the
        // executor throws and the attempt stays indeterminate for the probe to settle.
        const oid = extractCommitOid(response);
        return {
          vendorId: oid,
          version: null,
          // The parent commit is the content-addressed pre-state; the new OID the post-state.
          beforeHash: commit.parentCommit ?? null,
          afterHash: oid,
          evidenceIds: [`revision:${commit.revision}`, ...(commit.parentCommit ? [`parent:${commit.parentCommit}`] : [])],
        };
      }
      case "create_discussion": {
        const { title, body, pullRequest } = record.data as { title: string; body: string; pullRequest?: boolean };
        const d = await client.request(apiPath(r, "/discussions"), { method: "POST", body: JSON.stringify({ title, description: body, pull_request: Boolean(pullRequest) }) });
        if (!d || (d as any).num === undefined) throw new Error("Hugging Face discussion creation could not be verified.");
        return { vendorId: String((d as any).num), version: null, evidenceIds: [] };
      }
      case "comment_discussion": {
        const { number, body } = record.data as { number: number; body: string };
        if (!Number.isInteger(number) || number < 1) throw new Error("Stored comment payload is invalid.");
        const d = await client.request(apiPath(r, `/discussions/${number}/comment`), { method: "POST", body: JSON.stringify({ comment: body }) });
        if (!d) throw new Error("Hugging Face discussion comment could not be verified.");
        return { vendorId: null, version: null, evidenceIds: [`discussion:${number}`] };
      }
      case "pause_space":
      case "resume_space": {
        if (r.kind !== "space") throw new Error("Stored Space payload does not match the bound resource.");
        await client.request(apiPath(r, record.operation === "pause_space" ? "/pause" : "/restart"), { method: "POST" });
        return { vendorId: null, version: null, evidenceIds: [] };
      }
      default:
        throw new Error(`Hugging Face action executor does not support operation ${record.operation}.`);
    }
  }

  async rejectAction(actionId: number): Promise<void> {
    // Stage.reject itself gates on state and retires rather than deletes: the record is the
    // durable evidence that the proposal was rejected, and getWriteProposal() must keep
    // answering for it.
    await this.#stage.reject(actionId);
  }

  async revertAction(_actionId: number): Promise<void> { throw new Error("Hugging Face actions are not reversible after application."); }

  async stageAction(action: HuggingFaceWriteAction): Promise<number> {
    return this.#stage.stage(action);
  }

  async markActionPending(actionId: number): Promise<void> {
    await this.#stage.markPending(actionId);
  }

  async discardStagedAction(actionId: number): Promise<void> {
    await this.#stage.discardStaged(actionId);
  }

  async findActionByProposalId(proposalId: string): Promise<WriteProposal | null> {
    const record = await this.#stage.findByProposalId(proposalId);
    if (!record) return null;
    // Honest state: "simulated" until the execution journal holds a settled success — a recorded
    // approval decision alone does not mean the Hub change exists.
    const settled = await this.#journal.status(record.actionId);
    return { proposalId, actionId: record.actionId, operation: record.operation, summary: record.summary, simulated: settled !== "succeeded" };
  }
}

@validateRpc()
class HuggingFaceSessionImpl extends RpcTarget implements HuggingFaceSession {
  constructor(private readonly queue: Queue, private readonly env: Env, private readonly gatekeeper: HuggingFaceGatekeeper, private readonly resourceUrl?: string) { super(); }
  #resource(): Resource { return parseResource(this.resourceUrl ?? this.env.HF_RESOURCE_URL); }
  #client(): HubClient { return new HubClient(this.env.HF_TOKEN); }
  async getResource(): Promise<Resource | InferenceTarget> { const r = this.#resource(); return r.kind === "model" && this.env.HF_INFERENCE_MODEL ? { model: this.env.HF_INFERENCE_MODEL, provider: this.env.HF_INFERENCE_PROVIDER, task: "text-generation" } : r; }
  async getRepositoryInfo(): Promise<HuggingFaceRepository> { const r = this.#resource(); const data = await this.#client().request(apiPath(r)); await this.queue.authorizeObservation({ title: "Read Hugging Face repository metadata", description: `Read metadata for ${r.id}.` }); return { id: data.id ?? r.id, kind: r.kind, private: Boolean(data.private), sha: data.sha, lastModified: data.lastModified }; }
  async getModelCard(): Promise<HuggingFaceModelCard> { const r = this.#resource(); if (r.kind !== "model") throw new Error("The bound resource is not a model."); const d = await this.#client().request(apiPath(r)); await this.queue.authorizeObservation({ title: "Read Hugging Face model card", description: `Read bounded metadata for ${r.id}.` }); return { id: d.id ?? r.id, libraryName: d.library_name, pipelineTag: d.pipeline_tag, tags: Array.isArray(d.tags) ? d.tags.slice(0, 100) : [], summary: typeof d.cardData?.model_summary === "string" ? d.cardData.model_summary.slice(0, 4000) : undefined }; }
  async getDatasetInfo(): Promise<HuggingFaceDatasetInfo> { const r = this.#resource(); if (r.kind !== "dataset") throw new Error("The bound resource is not a dataset."); const d = await this.#client().request(apiPath(r)); await this.queue.authorizeObservation({ title: "Read Hugging Face dataset metadata", description: `Read bounded metadata for ${r.id}.` }); return { id: d.id ?? r.id, tags: Array.isArray(d.tags) ? d.tags.slice(0, 100) : [], gated: Boolean(d.gated), private: Boolean(d.private), description: typeof d.description === "string" ? d.description.slice(0, 4000) : undefined }; }
  async getSpaceInfo(): Promise<HuggingFaceSpaceInfo> { const r = this.#resource(); if (r.kind !== "space") throw new Error("The bound resource is not a Space."); const d = await this.#client().request(apiPath(r)); await this.queue.authorizeObservation({ title: "Read Hugging Face Space metadata", description: `Read bounded metadata for ${r.id}.` }); return { id: d.id ?? r.id, sdk: d.sdk, runtime: d.runtime?.stage, private: Boolean(d.private), stage: d.stage }; }
  async listFiles(path?: string, revision?: string): Promise<HuggingFaceFilePage> { const r = this.#resource(); const clean = (path ?? "").replace(/^\/+/, ""); if (clean.includes("..") || clean.length > 512) throw new Error("Invalid repository path."); const rev = validateRevision(revision); const d = await this.#client().request(apiPath(r, `/tree/${encodeURIComponent(rev)}?path=${encodeURIComponent(clean)}&recursive=false&limit=100`)); await this.queue.authorizeObservation({ title: "List Hugging Face files", description: `List bounded paths under ${r.id}.` }); return { entries: (Array.isArray(d) ? d : []).slice(0, 100).map((x: any) => ({ path: String(x.path).slice(0, 512), size: typeof x.size === "number" ? x.size : undefined, type: x.type === "directory" ? "directory" : "file", lfs: x.lfs && { oid: String(x.lfs.oid), size: Number(x.lfs.size) } })), truncated: Array.isArray(d) && d.length >= 100 }; }
  async readTextFile(path: string, revision = "main", maxBytes = 256_000): Promise<string> { if (path.includes("..") || path.startsWith("/") || path.length > 512 || maxBytes < 1 || maxBytes > 1_000_000) throw new Error("Invalid bounded file request."); const r = this.#resource(); const rev = validateRevision(revision); const text = await this.#client().readTextCapped(`https://huggingface.co/${r.kind === "model" ? "" : `${r.kind}s/`}${r.id}/resolve/${encodeURIComponent(rev)}/${path}`, maxBytes); await this.queue.authorizeObservation({ title: "Read Hugging Face text file", description: `Read a bounded text file from ${r.id}.` }); return text; }
  async queryDataset(options?: DatasetQueryOptions): Promise<DatasetQueryResult> {
    const r = this.#resource();
    if (r.kind !== "dataset") throw new Error("Dataset queries require a bound dataset.");
    const maxRows = boundedInt(options?.maxRows, 100, 1000);
    const maxBytes = boundedInt(options?.maxBytes, 1_000_000, 5_000_000);
    const client = this.#client();
    const { config: cfg, split: spl } = await resolveDatasetSplit(client, r, options);
    const d = await client.request(`https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(r.id)}&config=${encodeURIComponent(cfg)}&split=${encodeURIComponent(spl)}&offset=0&length=${Math.min(maxRows, 100)}`);
    const features = Array.isArray((d as any)?.features) ? (d as any).features : [];
    const rawRows = (Array.isArray((d as any)?.rows) ? (d as any).rows : []).slice(0, Math.min(maxRows, 100));
    const firstRow = rawRows.length ? ((rawRows[0] as any)?.row ?? rawRows[0]) : undefined;
    const columns = features.length
      ? features.slice(0, 200).map((f: any) => String(f?.name ?? "")).filter(Boolean)
      : firstRow && typeof firstRow === "object" ? Object.keys(firstRow).slice(0, 200) : [];
    const rows: unknown[][] = rawRows.map((x: any) => { const obj = (x?.row ?? x) as Record<string, unknown> | undefined; return columns.map((c: string) => obj?.[c]); });
    // Enforce the UTF-8 byte budget by dropping whole rows rather than truncating mid-value.
    const fitted = fitRowsToByteBudget(rows, maxBytes);
    const keptRows = fitted.kept;
    const truncated = fitted.truncated || Number((d as any)?.num_rows_total ?? 0) > keptRows.length;
    await this.queue.authorizeObservation({ title: "Query Hugging Face dataset", description: `Read bounded rows from ${r.id} (${cfg}/${spl}).` });
    return { columns, rows: keptRows, rowCount: keptRows.length, truncated };
  }

  /**
   * The paging form of the dataset query: the same bounded, verified contract as queryDataset
   * (fixed approved backend, config/split resolution, cumulative maxRows/maxBytes budgets), but
   * the budget fills across server-side offset windows instead of stopping at the first one.
   * Returns a live cursor capability whose `next()` delivers one bounded page per call; every
   * page re-authorizes its observation through this session's approval queue.
   */
  async queryDatasetPages(options?: DatasetQueryOptions): Promise<DatasetQueryPages> {
    const r = this.#resource();
    if (r.kind !== "dataset") throw new Error("Dataset queries require a bound dataset.");
    const maxRows = boundedInt(options?.maxRows, 100, 1000);
    const maxBytes = boundedInt(options?.maxBytes, 1_000_000, 5_000_000);
    const client = this.#client();
    const { config: cfg, split: spl } = await resolveDatasetSplit(client, r, options);
    await this.queue.authorizeObservation({ title: "Walk Hugging Face dataset pages", description: `Read bounded rows across pages from ${r.id} (${cfg}/${spl}).` });
    const base = `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(r.id)}&config=${encodeURIComponent(cfg)}&split=${encodeURIComponent(spl)}`;

    // Walk state: the server-side window offset (advances by what was FETCHED, so byte-clipped
    // rows are never re-fetched) plus the cumulative row and byte budgets from policy.
    let offset = 0;
    let rowsBudget = maxRows;
    let bytesBudget = maxBytes;
    let columns: string[] | undefined;
    let totalRows: number | undefined;
    let fetchedLastWindow = 0;
    let firstPage = true;

    const fetchPage = async (): Promise<LivePage<DatasetPage>> => {
      if (rowsBudget <= 0 || bytesBudget <= 0) return { items: [], exhausted: true };
      const length = Math.min(DATASET_PAGE_ROWS, rowsBudget);
      const d = await client.request(`${base}&offset=${offset}&length=${length}`);
      await this.queue.authorizeObservation({ title: "Read Hugging Face dataset page", description: `Read a bounded page of rows from ${r.id} at offset ${offset}.` });
      if (firstPage) {
        const features = Array.isArray((d as any)?.features) ? (d as any).features : [];
        columns = features.slice(0, 200).map((f: any) => String(f?.name ?? "")).filter(Boolean);
        firstPage = false;
      }
      totalRows = Number((d as any)?.num_rows_total ?? 0);
      const raw = Array.isArray((d as any)?.rows) ? (d as any).rows : [];
      fetchedLastWindow = raw.length;
      const rows: unknown[][] = raw.map((x: any) => { const obj = (x?.row ?? x) as Record<string, unknown> | undefined; return (columns ?? []).map((c: string) => obj?.[c]); });
      // Cumulative UTF-8 byte budget: whole rows are dropped rather than truncated mid-value, and
      // the page reports honestly when the budget clipped it.
      const fitted = fitRowsToByteBudget(rows, bytesBudget);
      const kept = fitted.kept;
      const truncated = fitted.truncated;
      bytesBudget -= new TextEncoder().encode(JSON.stringify(kept)).byteLength;
      rowsBudget -= kept.length;
      offset += fetchedLastWindow;
      const page: DatasetPage = { rows: kept, rowCount: kept.length, offset: offset - fetchedLastWindow, truncated };
      const exhausted = rows.length === 0 || fetchedLastWindow < length || offset >= totalRows || rowsBudget <= 0 || bytesBudget <= 0;
      return { items: [page], exhausted };
    };

    const source = new LivePageSource<DatasetPage>({ fetchPage, label: "Hugging Face dataset pages" });
    return new DatasetPagesCursor(source, () => columns ?? [], () => totalRows ?? 0);
  }
  async runInference(request: InferenceRequest): Promise<InferenceResult> {
    const r = this.#resource();
    if (r.kind !== "model") throw new Error("Inference requires a bound model.");
    const input = boundedString(request.input, 64_000, "input");
    const model = this.env.HF_INFERENCE_MODEL ?? r.id;
    const provider = this.env.HF_INFERENCE_PROVIDER;
    const maxTokens = request.maxOutputTokens === undefined ? undefined : boundedInt(request.maxOutputTokens, 512, 8_192);
    if (provider) {
      // OpenAI-compatible chat completions through the governed router when an explicit provider
      // is configured; the model and provider stay fixed by the binding. Reserved keys are
      // stripped so request parameters cannot override the governed target.
      const extra: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(request.parameters ?? {})) if (!["model", "messages", "max_tokens"].includes(k)) extra[k] = v;
      const d = await this.#client().request("https://router.huggingface.co/v1/chat/completions", { method: "POST", body: JSON.stringify({ model, messages: [{ role: "user", content: input }], max_tokens: maxTokens ?? 512, ...extra }) });
      await this.queue.authorizeObservation({ title: "Run Hugging Face inference", description: `Run bounded chat inference on ${model} via ${provider}.` });
      const text = typeof (d as any)?.choices?.[0]?.message?.content === "string" ? (d as any).choices[0].message.content : undefined;
      const finish = (d as any)?.choices?.[0]?.finish_reason;
      const capped = capOutput(text !== undefined ? text : d);
      return { output: capped.output, model, provider, truncated: capped.truncated || finish === "length" };
    }
    const result = await this.#client().request(`https://router.huggingface.co/hf-inference/models/${encodeURIComponent(model)}`, { method: "POST", body: JSON.stringify({ inputs: input, parameters: request.parameters }) });
    await this.queue.authorizeObservation({ title: "Run Hugging Face inference", description: `Run bounded inference on ${model}.` });
    const capped = capOutput(result);
    return { output: capped.output, model, provider: undefined, truncated: capped.truncated };
  }
  async listDiscussions(status?: "open" | "closed"): Promise<HuggingFaceCursor<DiscussionSummary>> {
    const r = this.#resource();
    const client = this.#client();
    await this.queue.authorizeObservation({ title: "List Hugging Face discussions", description: `List bounded discussions for ${r.id}.` });
    // Contract verified against the live Hub endpoint (api/models|datasets|spaces/{id}/discussions):
    // the response is { discussions: [...], count, start } — NOT a bare array — pages are dense in
    // matching items, the page size is fixed at 50 (the limit parameter is ignored), and paging is
    // a 0-based `p` offset. Exhaustion therefore comes from the reported count, never from page
    // shortness, and the walk is bounded by the cursor's page budget.
    const statusQuery = status === undefined ? "" : `&status=${status}`;
    const source = offsetPaged<DiscussionSummary>({
      pageSize: 50,
      label: "Hugging Face discussions",
      fetchPage: async (page) => {
        const d = await client.request(apiPath(r, `/discussions?p=${page}${statusQuery}`));
        await this.queue.authorizeObservation({ title: "Read Hugging Face discussions page", description: `Read a bounded page of discussions for ${r.id}.` });
        const list = Array.isArray((d as any)?.discussions) ? (d as any).discussions : [];
        const items: DiscussionSummary[] = list.slice(0, 100).map((x: any) => ({
          number: Number(x.num),
          title: String(x.title ?? "").slice(0, 300),
          status: x.status === "closed" ? "closed" : "open",
          kind: x.isPullRequest ? "pull_request" : "discussion",
          author: x.author?.name ? String(x.author.name).slice(0, 200) : undefined,
          createdAt: typeof x.createdAt === "string" ? x.createdAt.slice(0, 40) : undefined,
        }));
        return { items, total: Number((d as any)?.count ?? 0) };
      },
    });
    // A real Cap'n Web capability: the cursor is an RpcTarget stub the agent can keep calling,
    // bound to this session's resource and approval queue, not a POJO that fails RPC serialization.
    return new HubCursor<DiscussionSummary>(source);
  }

  async getDiscussion(number: number): Promise<HuggingFaceDiscussionDetail> {
    if (!Number.isInteger(number) || number < 1) throw new Error("Invalid discussion number.");
    const r = this.#resource();
    const d = await this.#client().request(apiPath(r, `/discussions/${number}`));
    await this.queue.authorizeObservation({ title: "Read Hugging Face discussion", description: `Read discussion #${number} for ${r.id}.` });
    const events = Array.isArray((d as any)?.events) ? (d as any).events : [];
    return {
      number: Number((d as any)?.num ?? number),
      title: String((d as any)?.title ?? "").slice(0, 300),
      status: (d as any)?.status === "closed" ? "closed" : "open",
      kind: (d as any)?.isPullRequest ? "pull_request" : "discussion",
      author: (d as any)?.author?.name ? String((d as any).author.name).slice(0, 200) : undefined,
      comments: events.filter((e: any) => e?.type === "comment").slice(0, 100).map((e: any) => ({
        author: e.author?.name ? String(e.author.name).slice(0, 200) : undefined,
        body: String(e.data ?? "").slice(0, 20_000),
        // Verified against the live endpoint: discussion events carry camelCase `createdAt`.
        createdAt: typeof e.createdAt === "string" ? e.createdAt.slice(0, 40) : undefined,
      })),
    };
  }
  async #proposal(operation: WriteProposal["operation"], summary: string, data: unknown, detail: string): Promise<WriteProposal> {
    const payload: HuggingFaceWriteAction = { proposalId: crypto.randomUUID(), operation, summary, data };
    const { actionId } = await proposeAction(this.gatekeeper, this.queue, payload, {
      title: `Hugging Face ${operation}`,
      description: [
        `Propose a **${operation}** on ${this.#resource().id}.`,
        "",
        detail,
        "",
        "This change has not been made on the Hub. It will be applied only if this action is approved.",
      ].join("\n"),
      implementsRevert: false,
    });
    return { proposalId: payload.proposalId, actionId, operation, summary, simulated: true };
  }
  async proposeCommit(message: string, changes: CommitFileChange[], revision?: string, parentCommit?: string): Promise<WriteProposal> {
    // The SAME V1 protocol validator the executor will run: a proposal that would be refused at
    // execution time is refused here, and the per-file content hashes it computes are stored in
    // the payload — repository, revision, parent commit, paths, and content are bound to approval.
    const commit = await validateCommit({ message, changes, revision, parentCommit });
    const detail = [
      `Commit message: ${message}`,
      `Revision: ${commit.revision}`,
      ...(parentCommit ? [`Parent commit: ${parentCommit}`] : []),
      `Changes (${commit.files.length} text file${commit.files.length === 1 ? "" : "s"}, ${commit.deletions.length} deletion${commit.deletions.length === 1 ? "" : "s"}):`,
      ...changes.map(c => `- ${c.operation} \`${c.path}\`${c.content !== undefined ? " (text)" : ""}`),
    ].join("\n");
    return this.#proposal("create_commit", `Propose a commit to ${this.#resource().id}.`, { message, changes, revision, parentCommit, fileHashes: commit.hashes }, detail);
  }
  async proposeDiscussion(title: string, body: string, pullRequest = false): Promise<WriteProposal> { const t = boundedString(title, 300, "title"); const b = boundedString(body, 20_000, "body"); const detail = `${pullRequest ? "Pull request" : "Discussion"} titled "${t}" with body:\n\n${b.slice(0, 2000)}${b.length > 2000 ? "\n…(truncated)" : ""}`; return this.#proposal("create_discussion", "Propose a Hugging Face discussion.", { title: t, body: b, pullRequest }, detail); }
  async proposeDiscussionComment(number: number, body: string): Promise<WriteProposal> { if (!Number.isInteger(number) || number < 1) throw new Error("Invalid discussion number."); const b = boundedString(body, 20_000, "body"); const detail = `Comment on discussion #${number}:\n\n${b.slice(0, 2000)}${b.length > 2000 ? "\n…(truncated)" : ""}`; return this.#proposal("comment_discussion", "Propose a Hugging Face discussion comment.", { number, body: b }, detail); }
  async proposeSpaceState(state: "pause" | "resume"): Promise<WriteProposal> { if (this.#resource().kind !== "space") throw new Error("Space state changes require a bound Space."); return this.#proposal(state === "pause" ? "pause_space" : "resume_space", `Propose to ${state} the Space.`, { state }, `Set the Space runtime state to **${state}**.`); }
  async getWriteProposal(proposalId: string): Promise<WriteProposal | null> { return this.gatekeeper.findActionByProposalId(proposalId); }
  [Symbol.dispose](): void { this.queue[Symbol.dispose]?.(); }
}

@validateRpc()
export class HuggingFaceAccount extends WorkerEntrypoint<Env> implements GatekeeperUser {
  async describe(): Promise<AccountDescription> { return { displayName: "Hugging Face", avatar: ICON, singleton: { tsType: "HuggingFaceSession" } }; }
  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<HuggingFaceSession>>> { return this.ctx.exports.HuggingFaceGatekeeper({}); }
  async getSupportedResources(): Promise<SupportedResource[]> { return RESOURCES; }
  async getGatekeeperClassFor(url: string): Promise<{ class: DurableObjectClass<Gatekeeper<HuggingFaceSession>>; resource: SupportedResource }> { const parsed = parseResource(url); const resource = RESOURCES.find(x => x.urlPattern.includes(`/${parsed.kind === "model" ? "models" : parsed.kind === "dataset" ? "datasets" : "spaces"}/`))!; return { class: this.ctx.exports.HuggingFaceGatekeeper({ props: { resourceUrl: url } }), resource }; }
  startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> { throw new Error("Hugging Face configurator is not enabled yet."); }
  async ensureResources(_patterns: string[]): Promise<{ url?: string }> { return {}; }
  async revoke(): Promise<void> {}
  async reconnect(): Promise<{ url: string }> { throw new Error("Hugging Face reconnect is not enabled; rotate the configured fine-grained token."); }
  async commitReconnect(_stageId: string): Promise<void> { throw new Error("Hugging Face reconnect is not enabled."); }
  async getAuthenticatedEmail(): Promise<string | null> { return null; }
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> { return this.ctx.exports.HuggingFaceVerifier({}); }
}
@validateRpc() export class HuggingFaceVerifier extends WorkerEntrypoint<Env> implements GatekeeperUserVerifier { verify(): void {} }

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> {
  async describe(): Promise<VendorDescription> { return { displayName: "Hugging Face", url: "https://huggingface.co", logo: ICON, color: "#ffcf00", tagline: "Governed model, dataset, Space, and inference access", description: "Connect scoped Hugging Face repositories and approved inference targets to Cloudflare OS.", autoProvisionsAccount: true }; }
  @skipRpcValidation() async createAccount(): Promise<Fetcher<GatekeeperUser>> { return this.ctx.exports.HuggingFaceAccount({}); }
  connectAccount(_callback: Fetcher<GatekeeperConnectCallback>, _options?: GatekeeperConnectOptions): Promise<{ url: string }> { throw new Error("Hugging Face uses the deployment's secret-backed account until OAuth is enabled."); }
  async getSupportedResources(): Promise<SupportedResource[]> { return RESOURCES; }
  async getTypeScriptTypes(): Promise<string> { return TYPES_CODE; }
}

export default { async fetch(): Promise<Response> { return new Response("Hugging Face Gatekeeper worker is running.", { headers: { "content-type": "text/plain" } }); } };
