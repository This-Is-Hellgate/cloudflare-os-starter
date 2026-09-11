import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type { AccountDescription, ApprovalQueue, Gatekeeper, GatekeeperConnectCallback, GatekeeperConnectOptions, GatekeeperUser, GatekeeperUserVerifier, ResourceConfiguratorFrame, ResourceDescription, SupportedResource, VendorDescription } from "@gadgets/workshop-shared/gatekeeper";
import type { CommitFileChange, DatasetQueryOptions, DiscussionSummary, HuggingFaceDatasetInfo, HuggingFaceFilePage, HuggingFaceModelCard, HuggingFaceRepository, HuggingFaceSession, HuggingFaceSpaceInfo, InferenceRequest, InferenceResult, InferenceTarget, WriteProposal } from "./types.js";
import TYPES_CODE from "./types-code.js";

const ICON = { url: "https://huggingface.co/front/assets/huggingface_logo-noborder.svg" };
const RESOURCES: SupportedResource[] = [
  { urlPattern: "https://huggingface.co/models/*", title: "Hugging Face model", description: "A scoped model repository and its bounded inference target.", grantable: true },
  { urlPattern: "https://huggingface.co/datasets/*", title: "Hugging Face dataset", description: "A scoped dataset repository and bounded query surface.", grantable: true },
  { urlPattern: "https://huggingface.co/spaces/*", title: "Hugging Face Space", description: "A scoped Space repository and controlled lifecycle actions.", grantable: true },
];

type Resource = HuggingFaceRepository & { kind: "model" | "dataset" | "space" };
type GatekeeperProps = { resourceUrl?: string };
type Queue = Pick<ApprovalQueue, "authorizeObservation" | "submitAction"> & Partial<{ [Symbol.dispose](): void }>;

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

class HubClient {
  constructor(private readonly token: string) { if (!token) throw new Error("Hugging Face credentials are not configured."); }
  async request(url: string, init: RequestInit = {}): Promise<any> {
    const headers = new Headers(init.headers); headers.set("Authorization", `Bearer ${this.token}`); headers.set("Accept", "application/json");
    const response = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) { if ([401, 403, 404].includes(response.status)) throw new Error(`Hugging Face resource is not accessible (${response.status}).`); throw new Error(`Hugging Face request failed (${response.status}).`); }
    return response.headers.get("content-type")?.includes("json") ? response.json() : response.text();
  }
}

@validateRpc()
export class HuggingFaceGatekeeper extends DurableObject<Env, GatekeeperProps> implements Gatekeeper<HuggingFaceSession> {
  #actions = new Map<number, unknown>();
  #url(): string | undefined { return this.ctx.props?.resourceUrl ?? this.env.HF_RESOURCE_URL; }
  async describe(): Promise<ResourceDescription> { const r = parseResource(this.#url()); return { url: `https://huggingface.co/${r.kind === "model" ? "models" : r.kind === "dataset" ? "datasets" : "spaces"}/${r.id}`, title: `Hugging Face ${r.kind}`, snippet: `Scoped ${r.kind} repository capability`, suggestedBindingName: `HUGGINGFACE_${r.kind.toUpperCase()}`, tsType: "HuggingFaceSession" }; }
  async getTypeScriptTypes(): Promise<string> { return TYPES_CODE; }
  async getAutoApprovableActions(): Promise<[]> { return []; }
  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<HuggingFaceSession> { return new HuggingFaceSessionImpl(approvalQueue.dup(), this.env, this, this.#url()); }
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> { throw new Error("Hugging Face bindings require tracked observer verification before sharing."); }
  async removeObserver(_id: string): Promise<void> {}
  async queueAction(actionId: number, action: unknown): Promise<void> { this.#actions.set(actionId, action); await this.ctx.storage.kv.put(`action:${actionId}`, action); }
  async applyAction(actionId: number): Promise<void> { const action = this.#actions.get(actionId) ?? await this.ctx.storage.kv.get(`action:${actionId}`); if (!action) throw new Error(`Unknown Hugging Face action: ${actionId}`); throw new Error("Hugging Face write application is disabled until the action executor is enabled."); }
  async rejectAction(actionId: number): Promise<void> { this.#actions.delete(actionId); await this.ctx.storage.kv.delete(`action:${actionId}`); }
  async revertAction(_actionId: number): Promise<void> { throw new Error("Hugging Face actions are not reversible after application."); }
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
  async listFiles(path?: string, revision?: string): Promise<HuggingFaceFilePage> { const r = this.#resource(); const clean = (path ?? "").replace(/^\/+/, ""); if (clean.includes("..") || clean.length > 512) throw new Error("Invalid repository path."); const rev = revision ?? "main"; if (!/^[A-Za-z0-9._/-]{1,128}$/.test(rev)) throw new Error("Invalid revision."); const d = await this.#client().request(apiPath(r, `/tree/${encodeURIComponent(rev)}?path=${encodeURIComponent(clean)}&recursive=false&limit=100`)); await this.queue.authorizeObservation({ title: "List Hugging Face files", description: `List bounded paths under ${r.id}.` }); return { entries: (Array.isArray(d) ? d : []).slice(0, 100).map((x: any) => ({ path: String(x.path).slice(0, 512), size: typeof x.size === "number" ? x.size : undefined, type: x.type === "directory" ? "directory" : "file", lfs: x.lfs && { oid: String(x.lfs.oid), size: Number(x.lfs.size) } })), truncated: Array.isArray(d) && d.length > 100 }; }
  async readTextFile(path: string, revision = "main", maxBytes = 256_000): Promise<string> { if (path.includes("..") || path.startsWith("/") || path.length > 512 || maxBytes < 1 || maxBytes > 1_000_000) throw new Error("Invalid bounded file request."); const r = this.#resource(); const d = await this.#client().request(`https://huggingface.co/${r.kind === "model" ? "" : `${r.kind}s/`}${r.id}/resolve/${encodeURIComponent(revision)}/${path}`); const text = String(d); await this.queue.authorizeObservation({ title: "Read Hugging Face text file", description: `Read a bounded text file from ${r.id}.` }); return text.slice(0, maxBytes); }
  async queryDataset(_options?: DatasetQueryOptions): Promise<{ columns: string[]; rows: unknown[][]; rowCount: number; truncated: boolean }> { throw new Error("Dataset queries require an approved dataset query backend and are not enabled in this first Worker."); }
  async runInference(request: InferenceRequest): Promise<InferenceResult> { const r = this.#resource(); if (r.kind !== "model") throw new Error("Inference requires a bound model."); const input = boundedString(request.input, 64_000, "input"); const model = this.env.HF_INFERENCE_MODEL ?? r.id; const result = await this.#client().request(`https://router.huggingface.co/hf-inference/models/${encodeURIComponent(model)}`, { method: "POST", body: JSON.stringify({ inputs: input, parameters: request.parameters }) }); await this.queue.authorizeObservation({ title: "Run Hugging Face inference", description: `Run bounded inference on ${model}.` }); return { output: result, model, provider: this.env.HF_INFERENCE_PROVIDER, truncated: false }; }
  async listDiscussions(status?: "open" | "closed"): Promise<any> { const r = this.#resource(); let page = 0; const client = this.#client(); const first = await client.request(`https://huggingface.co/api/${r.kind === "model" ? "models" : r.kind === "dataset" ? "datasets" : "spaces"}/${r.id}/discussions?status=${status ?? "open"}&limit=100`); await this.queue.authorizeObservation({ title: "List Hugging Face discussions", description: `List bounded discussions for ${r.id}.` }); const items: DiscussionSummary[] = (Array.isArray(first) ? first : []).slice(0, 100).map((x: any) => ({ number: Number(x.num), title: String(x.title ?? "").slice(0, 300), status: x.status === "closed" ? "closed" : "open", kind: x.isPullRequest ? "pull_request" : "discussion", author: x.author?.name ? String(x.author.name).slice(0, 200) : undefined })); return { next: async () => page++ === 0 ? items : null }; }
  async #proposal(operation: WriteProposal["operation"], summary: string, data: unknown): Promise<WriteProposal> { const proposalId = crypto.randomUUID(); const actionId = Date.now(); await this.gatekeeper.queueAction(actionId, { proposalId, operation, data }); await this.queue.submitAction(actionId, { title: "Hugging Face change", description: summary, implementsRevert: false }); return { proposalId, operation, summary, simulated: true }; }
  async proposeCommit(message: string, changes: CommitFileChange[], revision?: string): Promise<WriteProposal> { if (!message || changes.length < 1 || changes.length > 50) throw new Error("A commit requires 1–50 changes."); boundedString(message, 500, "message"); for (const c of changes) { if (!c.path || c.path.includes("..") || c.path.startsWith("/") || c.path.length > 512) throw new Error("Invalid commit path."); if (c.content !== undefined) boundedString(c.content, 1_000_000, "file content"); } return this.#proposal("create_commit", `Propose a commit to ${this.#resource().id}.`, { message, changes, revision }); }
  async proposeDiscussion(title: string, body: string, pullRequest = false): Promise<WriteProposal> { return this.#proposal("create_discussion", "Propose a Hugging Face discussion.", { title: boundedString(title, 300, "title"), body: boundedString(body, 20_000, "body"), pullRequest }); }
  async proposeDiscussionComment(number: number, body: string): Promise<WriteProposal> { if (!Number.isInteger(number) || number < 1) throw new Error("Invalid discussion number."); return this.#proposal("comment_discussion", "Propose a Hugging Face discussion comment.", { number, body: boundedString(body, 20_000, "body") }); }
  async proposeSpaceState(state: "pause" | "resume"): Promise<WriteProposal> { if (this.#resource().kind !== "space") throw new Error("Space state changes require a bound Space."); return this.#proposal(state === "pause" ? "pause_space" : "resume_space", `Propose to ${state} the Space.`, { state }); }
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
