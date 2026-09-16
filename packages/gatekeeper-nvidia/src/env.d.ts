interface Env {
  /** NVIDIA API key (Bearer). Required. */
  NVIDIA_API_KEY: string;
  /** Inference endpoint origin; defaults to https://integrate.api.nvidia.com. */
  NVIDIA_BASE_URL?: string;
  /** Comma-separated NIM model allowlist. REQUIRED: an empty allowlist allows nothing. */
  NVIDIA_ALLOWED_MODELS?: string;
  /** Optional per-model operator descriptions, JSON object of model id -> description. */
  NVIDIA_MODEL_NOTES?: string;
  /** Default requested output tokens (1-8192). */
  NVIDIA_MAX_TOKENS?: string;
  /** Concurrent-call allowance per account (1-4; default 2). */
  NVIDIA_CONCURRENCY?: string;
  /** Cumulative call allowance before the account refuses compute. */
  NVIDIA_BUDGET_CALLS?: string;
  /** Cumulative token allowance before the account refuses compute. */
  NVIDIA_BUDGET_TOKENS?: string;
}
