// Agent-facing API for the NVIDIA Gatekeeper (moderate capability tier).
//
// The bound account exposes the deployment's allowed NIM models. Tokens, arbitrary endpoints,
// and unallowlisted models are never exposed to the Gadget.

export interface NvidiaModelInfo {
  id: string;
  /** Operator-provided description when configured; never vendor marketing copy. */
  description?: string;
}

export interface NvidiaImagePart {
  /** A base64 data URI: `data:image/png;base64,...` (png, jpeg, webp, gif). */
  imageDataUri: string;
}

export interface NvidiaTextPart {
  text: string;
}

export type NvidiaMessagePart = NvidiaTextPart | NvidiaImagePart;

export interface NvidiaChatMessage {
  role: "user" | "assistant" | "system";
  parts: NvidiaMessagePart[];
}

export interface NvidiaInferOptions {
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
}

export interface NvidiaInferResult {
  text: string;
  model: string;
  truncated: boolean;
  usage: {
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
    /** Microunits of USD; null when no trustworthy price exists. */
    costMicrousd: number | null;
  };
}

export interface NvidiaEmbedOptions {
  /** Optional: embed image parts alongside/instead of text inputs (multimodal embedding). */
  imageUris?: string[];
  /** Optional dimension truncation, when the model supports it. */
  dimensions?: number;
}

export interface NvidiaEmbedResult {
  /** One embedding per text input, followed by one per image input. */
  embeddings: number[][];
  model: string;
  truncated: boolean;
}

export interface NvidiaRerankOptions {
  topN?: number;
}

export interface NvidiaRerankResult {
  /** Candidates in the vendor's relevance order with their scores. */
  results: { index: number; relevanceScore: number }[];
  model: string;
  truncated: boolean;
}

export interface NvidiaBudget {
  callsRemaining: number;
  tokensRemaining: number;
}

export interface NvidiaSession {
  /** Return the deployment's allowed models; binding to one is required before inference. */
  listModels(): Promise<NvidiaModelInfo[]>;
  /** Describe one allowed model; refuses anything outside the deployment allowlist. */
  describeModel(model: string): Promise<NvidiaModelInfo>;
  /** Run chat inference; text-only or image-bearing parts, against an allowed model. */
  infer(model: string, messages: NvidiaChatMessage[], options?: NvidiaInferOptions): Promise<NvidiaInferResult>;
  /** Embed text inputs and/or image parts on an allowed embedding model. */
  embed(model: string, inputs: string[], options?: NvidiaEmbedOptions): Promise<NvidiaEmbedResult>;
  /** Rerank a bounded candidate set against a query on an allowed reranking model. */
  rerank(model: string, query: string, documents: string[], options?: NvidiaRerankOptions): Promise<NvidiaRerankResult>;
  /** The account's remaining compute allowance. */
  getBudget(): Promise<NvidiaBudget>;
}
