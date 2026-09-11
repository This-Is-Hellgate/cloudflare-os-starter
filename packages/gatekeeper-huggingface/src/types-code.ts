const TYPES_CODE = `export interface HuggingFaceRepository { id: string; kind: "model" | "dataset" | "space"; private: boolean; sha?: string; lastModified?: string; }
export interface HuggingFaceFileEntry { path: string; size?: number; type: "file" | "directory"; lfs?: { oid: string; size: number }; }
export interface HuggingFaceFilePage { entries: HuggingFaceFileEntry[]; truncated: boolean; cursor?: string; }
export interface HuggingFaceModelCard { id: string; libraryName?: string; pipelineTag?: string; tags: string[]; summary?: string; }
export interface HuggingFaceDatasetInfo { id: string; tags: string[]; gated: boolean; private: boolean; description?: string; }
export interface HuggingFaceSpaceInfo { id: string; sdk?: string; runtime?: string; private: boolean; stage?: string; }
export interface DatasetQueryOptions { config?: string; split?: string; maxRows?: number; maxBytes?: number; }
export interface DatasetQueryResult { columns: string[]; rows: unknown[][]; rowCount: number; truncated: boolean; }
export interface InferenceTarget { model: string; provider?: string; task: "chat-completion" | "text-generation" | "feature-extraction" | "automatic-speech-recognition" | "text-to-image"; }
export interface InferenceRequest { input: string; parameters?: Record<string, string | number | boolean>; maxOutputTokens?: number; }
export interface InferenceResult { output: unknown; model: string; provider?: string; truncated: boolean; }
export interface DiscussionSummary { number: number; title: string; status: "open" | "closed"; kind: "discussion" | "pull_request"; author?: string; }
export interface WriteProposal { proposalId: string; operation: "create_commit" | "create_discussion" | "comment_discussion" | "pause_space" | "resume_space"; summary: string; simulated: boolean; }
export interface CommitFileChange { path: string; operation: "add" | "update" | "delete"; content?: string; }
export interface HuggingFaceCursor<T> { next(): Promise<T[] | null>; }
export interface HuggingFaceSession { getResource(): Promise<HuggingFaceRepository | InferenceTarget>; getRepositoryInfo(): Promise<HuggingFaceRepository>; getModelCard(): Promise<HuggingFaceModelCard>; getDatasetInfo(): Promise<HuggingFaceDatasetInfo>; getSpaceInfo(): Promise<HuggingFaceSpaceInfo>; listFiles(path?: string, revision?: string): Promise<HuggingFaceFilePage>; readTextFile(path: string, revision?: string, maxBytes?: number): Promise<string>; queryDataset(options?: DatasetQueryOptions): Promise<DatasetQueryResult>; runInference(request: InferenceRequest): Promise<InferenceResult>; listDiscussions(status?: "open" | "closed"): Promise<HuggingFaceCursor<DiscussionSummary>>; proposeCommit(message: string, changes: CommitFileChange[], revision?: string): Promise<WriteProposal>; proposeDiscussion(title: string, body: string, pullRequest?: boolean): Promise<WriteProposal>; proposeDiscussionComment(number: number, body: string): Promise<WriteProposal>; proposeSpaceState(state: "pause" | "resume"): Promise<WriteProposal>; }
`;
export default TYPES_CODE;
