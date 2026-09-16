import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type {
  AccountDescription, ApprovalQueue, Gatekeeper, GatekeeperConnectCallback, GatekeeperConnectOptions,
  GatekeeperUser, GatekeeperUserVerifier, ResourceConfiguratorFrame, ResourceDescription,
  SupportedResource, VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type {
  NvidiaBudget, NvidiaChatMessage, NvidiaEmbedOptions, NvidiaEmbedResult, NvidiaInferOptions,
  NvidiaInferResult, NvidiaMessagePart, NvidiaModelInfo, NvidiaRerankOptions, NvidiaRerankResult,
  NvidiaSession,
} from "./types.js";
import TYPES_CODE from "./types-code.js";
import {
  allowedModel, boundedText, nvidiaPolicy, validateApiKey, validateImagePart, totalImageBudget,
  MAX_EMBED_INPUTS, MAX_IMAGE_TOTAL_CHARS, MAX_OUTPUT_CHARS, MAX_OUTPUT_TOKENS, MAX_RERANK_CANDIDATES,
  MAX_TEXT_CHARS, type ComputeUsage, type NvidiaPolicy,
} from "./policy.js";

const ICON = { url: "https://www.nvidia.com/etc/designs/nvidia-web/clientlibs/assets/img/favicon-32x32.png" };
const RESOURCE: SupportedResource = {
  urlPattern: "nvidia://account/*",
  title: "NVIDIA compute account",
  description: "Governed accelerated inference, embedding, and reranking over the deployment's allowed NIM models.",
  grantable: true,
};

type NvidiaProps = { account?: string };
const INFER_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Wire protocol (OpenAI-compatible chat/VLM, embeddings, retrieval reranking)

interface ChatResponseShape {
  choices?: { message?: { content?: unknown }; finish_reason?: unknown }[];
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
}
interface EmbeddingsResponseShape {
  data?: { embedding?: unknown }[];
}
interface RerankResponseShape {
  results?: { index?: unknown; relevance_score?: unknown }[];
}

function asInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
}

function usageFrom(response: ChatResponseShape): ComputeUsage {
  const usage = response.usage ?? {};
  return {
    promptTokens: asInt(usage.prompt_tokens),
    completionTokens: asInt(usage.completion_tokens),
    totalTokens: asInt(usage.total_tokens),
    // No trustworthy price source: cost stays explicitly null, never zero-fabricated.
    costMicrousd: null,
  };
}

/** Extracts the assistant text from an OpenAI-shaped response, including array-content parts. */
function textFrom(response: ChatResponseShape): string {
  const choice = Array.isArray(response.choices) ? response.choices[0] : undefined;
  const content = choice?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
      .join("");
  }
  throw new Error("NVIDIA inference response could not be verified.");
}

class NvidiaApi {
  constructor(private readonly env: Env, private readonly policy: NvidiaPolicy) {}
  #headers(): HeadersInit {
    return { authorization: `Bearer ${validateApiKey(this.env.NVIDIA_API_KEY)}`, "content-type": "application/json", accept: "application/json" };
  }
  async #post(path: string, body: Record<string, unknown>, label: string): Promise<any> {
    const response = await fetch(`${this.policy.baseUrl}${path}`, {
      method: "POST",
      headers: this.#headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(INFER_TIMEOUT_MS),
    });
    if (!response.ok) {
      if ([401, 403].includes(response.status)) throw new Error("NVIDIA credentials are not authorized for this model.");
      throw new Error(`NVIDIA ${label} failed (${response.status}).`);
    }
    return response.json();
  }

  async chat(model: string, messages: unknown[], options: { maxTokens: number; temperature?: number; topP?: number; stop?: string[] }): Promise<{ text: string; usage: ComputeUsage; finishReason: string | null }> {
    const data = (await this.#post("/v1/chat/completions", {
      model,
      messages,
      max_tokens: options.maxTokens,
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.topP === undefined ? {} : { top_p: options.topP }),
      ...(options.stop?.length ? { stop: options.stop } : {}),
      stream: false,
    }, "inference")) as ChatResponseShape;
    return { text: textFrom(data), usage: usageFrom(data), finishReason: typeof data.choices?.[0]?.finish_reason === "string" ? data.choices[0].finish_reason : null };
  }

  async embeddings(model: string, input: unknown, dimensions?: number): Promise<number[][]> {
    const data = (await this.#post("/v1/embeddings", { model, input, ...(dimensions === undefined ? {} : { dimensions }) }, "embedding")) as EmbeddingsResponseShape;
    const out = (Array.isArray(data.data) ? data.data : []).map((d) => d.embedding);
    if (!out.every((e) => Array.isArray(e) && e.every((n) => typeof n === "number") && e.length <= 8_192)) {
      throw new Error("NVIDIA embedding response could not be verified.");
    }
    return out as number[][];
  }

  async rerank(model: string, query: string, passages: { text: string }[], topN: number | undefined): Promise<{ index: number; relevanceScore: number }[]> {
    const data = (await this.#post("/v1/retrieval/reranking", { model, query: { text: query }, passages, ...(topN === undefined ? {} : { top_n: topN }) }, "reranking")) as RerankResponseShape;
    const results = (Array.isArray(data.results) ? data.results : []).map((r) => ({ index: asInt(r.index), relevanceScore: typeof r.relevance_score === "number" ? r.relevance_score : NaN }));
    if (!results.length || results.some((r) => r.index === null || Number.isNaN(r.relevanceScore))) {
      throw new Error("NVIDIA reranking response could not be verified.");
    }
    return results as { index: number; relevanceScore: number }[];
  }
}

// ---------------------------------------------------------------------------
// Budget + concurrency governance inside the account DO

/** Budget accounting keys; counters are cumulative "spent" against operator allowances. */
const CALLS_SPENT = "budget:calls";
const TOKENS_SPENT = "budget:tokens";

/** Tracks in-flight calls against the operator's concurrency allowance. */
class CallGate {
  #inFlight = 0;
  constructor(private readonly limit: number) {}
  /** Resolves when a slot is acquired; the returned release must run in a finally block. */
  async acquire(): Promise<() => void> {
    while (this.#inFlight >= this.limit) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    this.#inFlight += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#inFlight -= 1;
    };
  }
}

@validateRpc()
export class NvidiaGatekeeper extends DurableObject<Env, NvidiaProps> implements Gatekeeper<NvidiaSession> {
  readonly #gate: CallGate;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#gate = new CallGate(nvidiaPolicy(env).concurrency);
  }

  #env(): Env { return this.env; }
  #policy(): NvidiaPolicy { return nvidiaPolicy(this.#env()); }

  async describe(): Promise<ResourceDescription> { return { url: `nvidia://${this.ctx.props?.account ?? "account"}`, title: "NVIDIA compute capability", snippet: "Governed inference, embedding, and reranking over the deployment's allowed NIM models.", suggestedBindingName: "NVIDIA", tsType: "NvidiaSession" }; }
  async getTypeScriptTypes() { return TYPES_CODE; }
  async getAutoApprovableActions(): Promise<[]> { return []; }
  async startSession(q: RpcStub<ApprovalQueue>): Promise<NvidiaSession> { return new NvidiaSessionImpl(q.dup(), this.env, this); }
  // NVIDIA surfaces compute only. There are no staged write actions: the compute allowance in
  // this DO (calls/tokens, enforced before dispatch) is the governance for everything here.
  async applyAction(_actionId: number): Promise<void> { throw new Error("NVIDIA surfaces compute only; there are no approval-queue write actions."); }
  async rejectAction(_actionId: number): Promise<void> { throw new Error("NVIDIA surfaces compute only; there are no approval-queue write actions."); }
  async revertAction(_actionId: number): Promise<void> { throw new Error("NVIDIA surfaces compute only; there is nothing to revert."); }
  async addObserver() { throw new Error("NVIDIA bindings require tracked observer verification before sharing."); }
  async removeObserver() {}

  /** Remaining compute allowance; the one place the counters are read. */
  async getBudget(): Promise<NvidiaBudget> {
    const policy = this.#policy();
    const [calls, tokens] = await Promise.all([
      this.ctx.storage.get<number>(CALLS_SPENT),
      this.ctx.storage.get<number>(TOKENS_SPENT),
    ]);
    return {
      callsRemaining: Math.max(0, policy.budgetCalls - (calls ?? 0)),
      tokensRemaining: Math.max(0, policy.budgetTokens - (tokens ?? 0)),
    };
  }

  /** Refuses compute when either allowance is exhausted; called before every dispatch. */
  async #reserve(): Promise<void> {
    const budget = await this.getBudget();
    if (budget.callsRemaining < 1) throw new Error("NVIDIA compute budget is exhausted (calls). Raise NVIDIA_BUDGET_CALLS deliberately.");
    if (budget.tokensRemaining < 1) throw new Error("NVIDIA compute budget is exhausted (tokens). Raise NVIDIA_BUDGET_TOKENS deliberately.");
  }

  /** Settles actual usage after dispatch; usage the vendor did not report is not fabricated. */
  async #settle(usage: ComputeUsage): Promise<void> {
    const calls = ((await this.ctx.storage.get<number>(CALLS_SPENT)) ?? 0) + 1;
    await this.ctx.storage.put(CALLS_SPENT, calls);
    if (usage.totalTokens !== null) {
      const tokens = ((await this.ctx.storage.get<number>(TOKENS_SPENT)) ?? 0) + Math.max(0, usage.totalTokens);
      await this.ctx.storage.put(TOKENS_SPENT, tokens);
    }
  }

  /** Notes a call whose usage the vendor did not report: the token cost is unknown. */
  async #settleUnknownUsage(): Promise<void> {
    const calls = ((await this.ctx.storage.get<number>(CALLS_SPENT)) ?? 0) + 1;
    await this.ctx.storage.put(CALLS_SPENT, calls);
  }

  /** Runs one compute operation under the concurrency gate, budget reserve, and usage settle. */
  async compute<T>(operation: () => Promise<{ usage: ComputeUsage | null; value: T }>): Promise<T> {
    await this.#reserve();
    const release = await this.#gate.acquire();
    try {
      const outcome = await operation();
      if (outcome.usage) await this.#settle(outcome.usage);
      else await this.#settleUnknownUsage();
      return outcome.value;
    } finally {
      release();
    }
  }

  api(): NvidiaApi { return new NvidiaApi(this.#env(), this.#policy()); }
  modelNotes(): Map<string, string> {
    let parsed: unknown;
    const notesRaw = this.#env().NVIDIA_MODEL_NOTES;
    try { parsed = notesRaw ? JSON.parse(notesRaw) : undefined; } catch { parsed = undefined; }
    const notes = new Map<string, string>();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string") notes.set(k, v.slice(0, 1_000));
      }
    }
    return notes;
  }
}

@validateRpc()
class NvidiaSessionImpl extends RpcTarget implements NvidiaSession {
  constructor(private readonly queue: Pick<ApprovalQueue, "authorizeObservation"> & Partial<{ [Symbol.dispose](): void }>, private readonly env: Env, private readonly gatekeeper: NvidiaGatekeeper) { super(); }

  async listModels(): Promise<NvidiaModelInfo[]> {
    const policy = nvidiaPolicy(this.env);
    const notes = this.gatekeeper.modelNotes();
    const models = [...policy.allowedModels].sort();
    await this.queue.authorizeObservation({ title: "List NVIDIA models", description: `List the ${models.length} allowed NIM model(s).` });
    return models.map((id) => ({ id, description: notes.get(id) }));
  }

  async describeModel(model: string): Promise<NvidiaModelInfo> {
    const policy = nvidiaPolicy(this.env);
    const id = allowedModel(policy, model);
    await this.queue.authorizeObservation({ title: "Describe NVIDIA model", description: `Read the allowlist entry for ${id}.` });
    return { id, description: this.gatekeeper.modelNotes().get(id) };
  }

  async infer(model: string, messages: NvidiaChatMessage[], options?: NvidiaInferOptions): Promise<NvidiaInferResult> {
    const policy = nvidiaPolicy(this.env);
    const id = allowedModel(policy, model);
    if (!Array.isArray(messages) || messages.length < 1 || messages.length > 32) throw new Error("Inference requires 1-32 messages.");
    const imageParts: ReturnType<typeof validateImagePart>[] = [];
    let textChars = 0;
    const wire = messages.map((message, mi) => {
      if (typeof message?.role !== "string" || !["user", "assistant", "system"].includes(message.role)) {
        throw new Error(`Message ${mi} has an invalid role.`);
      }
      if (!Array.isArray(message.parts) || message.parts.length < 1 || message.parts.length > 64) {
        throw new Error(`Message ${mi} requires 1-64 parts.`);
      }
      const content = message.parts.map((part: NvidiaMessagePart, pi: number) => {
        if ("text" in part) {
          textChars += part.text.length;
          boundedText(part.text, MAX_TEXT_CHARS, `Message ${mi} part ${pi}`);
          return { type: "text", text: part.text };
        }
        const validated = validateImagePart(part.imageDataUri, mi * 100 + pi);
        imageParts.push(validated);
        return { type: "image_url", image_url: { url: validated.dataUri } };
      });
      return { role: message.role, content };
    });
    if (textChars > MAX_TEXT_CHARS) throw new Error(`Text exceeds the ${MAX_TEXT_CHARS}-character limit.`);
    totalImageBudget(imageParts);
    const maxTokens = options?.maxOutputTokens === undefined ? policy.defaultMaxTokens : Math.min(Math.max(1, options.maxOutputTokens), MAX_OUTPUT_TOKENS);
    if (options?.temperature !== undefined && (typeof options.temperature !== "number" || options.temperature < 0 || options.temperature > 2)) throw new Error("temperature must be within [0, 2].");
    if (options?.topP !== undefined && (typeof options.topP !== "number" || options.topP <= 0 || options.topP > 1)) throw new Error("topP must be within (0, 1].");
    if (options?.stop !== undefined) {
      if (!Array.isArray(options.stop) || options.stop.length > 4 || options.stop.some((s) => typeof s !== "string" || s.length < 1 || s.length > 64)) throw new Error("stop requires at most 4 strings of 1-64 characters.");
    }
    await this.queue.authorizeObservation({
      title: "Run NVIDIA inference",
      description: `Run bounded ${imageParts.length ? "multimodal " : ""}inference on ${id} (${messages.length} messages${imageParts.length ? `, ${imageParts.length} image parts` : ""}).`,
    });
    const { text, usage } = await this.gatekeeper.compute(() =>
      this.gatekeeper.api().chat(id, wire, {
        maxTokens,
        ...(options?.temperature === undefined ? {} : { temperature: options.temperature }),
        ...(options?.topP === undefined ? {} : { topP: options.topP }),
        ...(options?.stop?.length ? { stop: options.stop } : {}),
      }).then((r) => ({ usage: r.usage, value: r })),
    );
    const truncated = usage.completionTokens !== null && usage.completionTokens >= maxTokens;
    const capped = text.length > MAX_OUTPUT_CHARS;
    return { text: capped ? text.slice(0, MAX_OUTPUT_CHARS) : text, model: id, truncated: truncated || capped, usage };
  }

  async embed(model: string, inputs: string[], options?: NvidiaEmbedOptions): Promise<NvidiaEmbedResult> {
    const policy = nvidiaPolicy(this.env);
    const id = allowedModel(policy, model);
    if (!Array.isArray(inputs) || inputs.length > MAX_EMBED_INPUTS) throw new Error(`Embedding requires at most ${MAX_EMBED_INPUTS} text inputs.`);
    for (const input of inputs) boundedText(input, MAX_TEXT_CHARS, "Embedding input");
    let imageParts: ReturnType<typeof validateImagePart>[] = [];
    if (options?.imageUris !== undefined) {
      if (!Array.isArray(options.imageUris) || options.imageUris.length > MAX_EMBED_INPUTS) throw new Error(`Embedding requires at most ${MAX_EMBED_INPUTS} image inputs.`);
      imageParts = options.imageUris.map((uri, i) => validateImagePart(uri, i));
    }
    if (!inputs.length && !imageParts.length) throw new Error("Embedding requires at least one text or image input.");
    totalImageBudget(imageParts);
    if (options?.dimensions !== undefined && (!Number.isInteger(options.dimensions) || options.dimensions < 1 || options.dimensions > 8_192)) throw new Error("dimensions must be within 1-8192.");
    await this.queue.authorizeObservation({
      title: "Run NVIDIA embedding",
      description: `Embed ${inputs.length} text and ${imageParts.length} image input(s) on ${id}.`,
    });
    const embeddings = await this.gatekeeper.compute(() =>
      this.gatekeeper.api().embeddings(id, imageParts.length
        ? [
            ...inputs.map((text: string) => ({ type: "text", text })),
            ...imageParts.map((part) => ({ type: "image_url", image_url: { url: part.dataUri } })),
          ]
        : inputs, options?.dimensions).then((listed: number[][]) => {
        if (listed.length !== inputs.length + imageParts.length) throw new Error("NVIDIA embedding count does not match the request.");
        return { usage: null, value: listed };
      }),
    );
    return { embeddings, model: id, truncated: false };
  }

  async rerank(model: string, query: string, documents: string[], options?: NvidiaRerankOptions): Promise<NvidiaRerankResult> {
    const policy = nvidiaPolicy(this.env);
    const id = allowedModel(policy, model);
    boundedText(query, MAX_TEXT_CHARS, "Rerank query");
    if (!Array.isArray(documents) || documents.length < 1 || documents.length > MAX_RERANK_CANDIDATES) throw new Error(`Reranking requires 1-${MAX_RERANK_CANDIDATES} documents.`);
    for (const document of documents) boundedText(document, MAX_TEXT_CHARS, "Rerank document");
    let topN: number | undefined;
    if (options?.topN !== undefined) {
      if (!Number.isInteger(options.topN) || options.topN < 1 || options.topN > documents.length) throw new Error("topN must be within 1..documents.length.");
      topN = options.topN;
    }
    await this.queue.authorizeObservation({ title: "Run NVIDIA reranking", description: `Rerank ${documents.length} documents against a query on ${id}.` });
    const ranked = await this.gatekeeper.compute(() =>
      this.gatekeeper.api().rerank(id, query, documents.map((text: string) => ({ text })), topN).then((listed: { index: number; relevanceScore: number }[]) => {
        const bounded = listed.slice(0, documents.length);
        if (bounded.some((r) => r.index < 0 || r.index >= documents.length)) throw new Error("NVIDIA reranking returned an out-of-range index.");
        return { usage: null, value: bounded };
      }),
    );
    return { results: ranked, model: id, truncated: ranked.length < documents.length };
  }

  async getBudget(): Promise<NvidiaBudget> { return this.gatekeeper.getBudget(); }
  [Symbol.dispose](): void { this.queue[Symbol.dispose]?.(); }
}

// ---------------------------------------------------------------------------
// Vendor entrypoints (account, verifier, vendor description)

@validateRpc()
export class NvidiaAccount extends WorkerEntrypoint<NvidiaProps> implements GatekeeperUser {
  async describe(): Promise<AccountDescription> { return { displayName: "NVIDIA", avatar: ICON, singleton: { tsType: "NvidiaSession" } }; }
  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<NvidiaSession>>> { return (this.ctx.exports as unknown as { NvidiaGatekeeper: (props: { props?: NvidiaProps }) => DurableObjectClass<Gatekeeper<NvidiaSession>> }).NvidiaGatekeeper({}); }
  async getSupportedResources(): Promise<SupportedResource[]> { return [RESOURCE]; }
  async getGatekeeperClassFor(url: string): Promise<{ class: DurableObjectClass<Gatekeeper<NvidiaSession>>; resource: SupportedResource }> {
    const parsed = new URL(url);
    if (parsed.protocol !== "nvidia:") throw new Error("NVIDIA resource must use nvidia://.");
    return { class: (this.ctx.exports as unknown as { NvidiaGatekeeper: (props: { props?: NvidiaProps }) => DurableObjectClass<Gatekeeper<NvidiaSession>> }).NvidiaGatekeeper({ props: { account: parsed.hostname } }), resource: RESOURCE };
  }
  startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> { throw new Error("NVIDIA configurator is not enabled yet; use the explicitly configured account."); }
  async ensureResources(_patterns: string[]): Promise<{ url?: string }> { return {}; }
  async revoke(): Promise<void> {}
  async reconnect(): Promise<{ url: string }> { throw new Error("NVIDIA reconnect is not enabled; rotate the configured NVIDIA_API_KEY."); }
  async commitReconnect(_stageId: string): Promise<void> { throw new Error("NVIDIA reconnect is not enabled."); }
  async getAuthenticatedEmail(): Promise<string | null> { return null; }
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> { return (this.ctx.exports as unknown as { NvidiaVerifier: () => Fetcher<GatekeeperUserVerifier> }).NvidiaVerifier(); }
}
@validateRpc() export class NvidiaVerifier extends WorkerEntrypoint<NvidiaProps> implements GatekeeperUserVerifier { verify(): void {} }

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<NvidiaProps> {
  async describe(): Promise<VendorDescription> { return { displayName: "NVIDIA", url: "https://www.nvidia.com", logo: ICON, color: "#76b900", tagline: "Governed accelerated compute", description: "Connect the deployment's allowed NIM models: bounded inference, embeddings, multimodal, and reranking.", autoProvisionsAccount: true }; }
  @skipRpcValidation() async createAccount(): Promise<Fetcher<GatekeeperUser>> { return (this.ctx.exports as unknown as { NvidiaAccount: () => Fetcher<GatekeeperUser> }).NvidiaAccount(); }
  async connectAccount(_callback: Fetcher<GatekeeperConnectCallback>, _options?: GatekeeperConnectOptions): Promise<{ url: string }> { throw new Error("NVIDIA uses the deployment's secret-backed account; interactive connect is not enabled."); }
  async getSupportedResources(): Promise<SupportedResource[]> { return [RESOURCE]; }
  async getTypeScriptTypes(): Promise<string> { return TYPES_CODE; }
}

export default {
  async fetch(): Promise<Response> {
    return new Response("NVIDIA Gatekeeper worker is running.", { headers: { "content-type": "text/plain" } });
  },
};
