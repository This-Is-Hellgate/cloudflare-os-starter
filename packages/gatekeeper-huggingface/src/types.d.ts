/**
 * Agent-facing API for the Hugging Face Gatekeeper (moderate capability tier).
 *
 * The bound URL selects one Hub repository or one explicitly configured inference
 * target. Tokens, arbitrary Hub URLs, and unrestricted organization administration
 * are never exposed to the Gadget.
 */

export type HuggingFaceRepositoryKind = "model" | "dataset" | "space";

export interface HuggingFaceRepository {
  /** Canonical namespace/repository identifier, for example `org/model`. */
  id: string;
  kind: HuggingFaceRepositoryKind;
  private: boolean;
  sha?: string;
  lastModified?: string;
}

export interface HuggingFaceFileEntry {
  path: string;
  size?: number;
  /** File type as reported by the Hub; never interpreted as executable authority. */
  type: "file" | "directory";
  lfs?: { oid: string; size: number };
}

export interface HuggingFaceFilePage {
  entries: HuggingFaceFileEntry[];
  truncated: boolean;
  cursor?: string;
}

export interface HuggingFaceModelCard {
  id: string;
  libraryName?: string;
  pipelineTag?: string;
  tags: string[];
  /** Bounded card text, treated as untrusted vendor content. */
  summary?: string;
}

export interface HuggingFaceDatasetInfo {
  id: string;
  tags: string[];
  gated: boolean;
  private: boolean;
  description?: string;
}

export interface HuggingFaceSpaceInfo {
  id: string;
  sdk?: string;
  runtime?: string;
  private: boolean;
  stage?: string;
}

export interface DatasetQueryOptions {
  /** Named subset and split, when the dataset exposes them. */
  config?: string;
  split?: string;
  /** Maximum rows and bytes returned by the server. */
  maxRows?: number;
  maxBytes?: number;
}

export interface DatasetQueryResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
}

export interface InferenceTarget {
  model: string;
  provider?: string;
  task: "chat-completion" | "text-generation" | "feature-extraction" | "automatic-speech-recognition" | "text-to-image";
}

export interface InferenceRequest {
  /** Prompt or task-specific input; size is server-bounded. */
  input: string;
  parameters?: Record<string, string | number | boolean>;
  maxOutputTokens?: number;
}

export interface InferenceResult {
  output: unknown;
  model: string;
  provider?: string;
  truncated: boolean;
}

export interface DiscussionSummary {
  number: number;
  title: string;
  status: "open" | "closed";
  kind: "discussion" | "pull_request";
  author?: string;
}

export interface WriteProposal {
  proposalId: string;
  /** Sequential, Gatekeeper-assigned action id; the id the approval flow will call back with. */
  actionId: number;
  operation: "create_commit" | "create_discussion" | "comment_discussion" | "pause_space" | "resume_space";
  summary: string;
  /** True when the proposal can be simulated without contacting a mutating endpoint. */
  simulated: boolean;
}

export interface CommitFileChange {
  path: string;
  operation: "add" | "update" | "delete";
  /** Text content is bounded and never treated as executable by the Gatekeeper. */
  content?: string;
}

export interface HuggingFaceCursor<T> {
  next(): Promise<T[] | null>;
}

export interface HuggingFaceSession {
  /** Return the bound repository or inference target, never credentials. */
  getResource(): Promise<HuggingFaceRepository | InferenceTarget>;

  /** Read bounded repository metadata and model/dataset/Space details. */
  getRepositoryInfo(): Promise<HuggingFaceRepository>;
  getModelCard(): Promise<HuggingFaceModelCard>;
  getDatasetInfo(): Promise<HuggingFaceDatasetInfo>;
  getSpaceInfo(): Promise<HuggingFaceSpaceInfo>;

  /** List only paths under the bound repository and revision. */
  listFiles(path?: string, revision?: string): Promise<HuggingFaceFilePage>;
  /** Read a bounded text/configuration file; binary/model weights are not returned inline. */
  readTextFile(path: string, revision?: string, maxBytes?: number): Promise<string>;
  queryDataset(options?: DatasetQueryOptions): Promise<DatasetQueryResult>;

  /** Run inference only against the explicitly bound model/provider target. */
  runInference(request: InferenceRequest): Promise<InferenceResult>;

  listDiscussions(status?: "open" | "closed"): Promise<HuggingFaceCursor<DiscussionSummary>>;

  /**
   * Queue an externally visible Hub change. The Gatekeeper simulates it and performs
   * the remote operation only after the Workshop approval flow applies the proposal.
   */
  proposeCommit(message: string, changes: CommitFileChange[], revision?: string): Promise<WriteProposal>;
  proposeDiscussion(title: string, body: string, pullRequest?: boolean): Promise<WriteProposal>;
  proposeDiscussionComment(number: number, body: string): Promise<WriteProposal>;
  proposeSpaceState(state: "pause" | "resume"): Promise<WriteProposal>;
  /** Read the durable state of a previously proposed change, or null when unknown. */
  getWriteProposal(proposalId: string): Promise<WriteProposal | null>;
}
