// NVIDIA capability policy: credential validation, the operator model allowlist, structural
// bounds for every request class (text, image-bearing, rerank), and the compute-budget
// accounting the account DO enforces before dispatch.
//
// Kept free of `cloudflare:workers` imports so the policy is unit-testable.

/** Maximum characters of one text input (prompt, message content, rerank document). */
export const MAX_TEXT_CHARS = 256_000;
/** Maximum characters of one agent-facing output. */
export const MAX_OUTPUT_CHARS = 1_000_000;
/** Hard ceiling on requested output tokens. */
export const MAX_OUTPUT_TOKENS = 8_192;
/** Default and hard ceilings on per-part and total base64 image bytes. */
export const MAX_IMAGE_PART_CHARS = 262_144; // 256 KiB of base64 ≈ 192 KiB binary
export const MAX_IMAGE_TOTAL_CHARS = 786_432; // 768 KiB across all image parts of one request
/** Rerank candidate and request bounds. */
export const MAX_RERANK_CANDIDATES = 100;
export const MAX_EMBED_INPUTS = 96;
/** Default concurrent-call allowance per account; the deployment may lower it, never raise it. */
export const DEFAULT_CONCURRENCY = 2;
export const MAX_CONCURRENCY_CAP = 4;
/** Default compute allowances; operators lower them, the caps bound misconfiguration. */
export const DEFAULT_BUDGET_CALLS = 1_000;
export const MAX_BUDGET_CALLS_CAP = 100_000;
export const DEFAULT_BUDGET_TOKENS = 2_000_000;
export const MAX_BUDGET_TOKENS_CAP = 100_000_000;
/** One inference request's model must be on the deployment allowlist; no dynamic discovery. */
export const MAX_ALLOWED_MODELS = 64;
/** The NVIDIA_API_KEY is a bearer token; sanity-shape it without pretending to validate it. */
export function validateApiKey(key: string | undefined): string {
  if (!key || key.length < 8 || key.length > 4096 || !/^[\x21-\x7e]+$/.test(key)) {
    throw new Error("NVIDIA credentials are not configured.");
  }
  return key;
}

export interface NvidiaPolicy {
  /** Operator allowlist of NIM model identifiers; empty means no model may be used. */
  allowedModels: Set<string>;
  /** The inference endpoint base (operator config; never model-chosen). */
  baseUrl: string;
  /** Default output-token request when the caller omits it. */
  defaultMaxTokens: number;
  /** Concurrent-call allowance per account DO. */
  concurrency: number;
  /** Cumulative call/token allowances enforced in the account DO. */
  budgetCalls: number;
  budgetTokens: number;
}

function allow(raw: string | undefined): Set<string> {
  return new Set((raw ?? "").split(",").map((x) => x.trim()).filter(Boolean));
}

function positiveInt(raw: string | undefined, fallback: number, cap: number): number {
  const n = Number(raw ?? fallback);
  return Number.isInteger(n) && n > 0 ? Math.min(n, cap) : fallback;
}

/** URL guard: HTTPS only, no path-pinning beyond an optional prefix the operator configures. */
function normalizeBaseUrl(raw: string | undefined): string {
  const url = raw ?? "https://integrate.api.nvidia.com";
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/.test(url.replace(/\/$/, ""))) {
    throw new Error("NVIDIA_BASE_URL must be an https origin.");
  }
  return url.replace(/\/$/, "");
}

export function nvidiaPolicy(env: Env): NvidiaPolicy {
  const allowedModels = allow(env.NVIDIA_ALLOWED_MODELS);
  if (allowedModels.size > MAX_ALLOWED_MODELS) throw new Error("The model allowlist exceeds the configured cap.");
  const defaultMaxTokens = positiveInt(env.NVIDIA_MAX_TOKENS, 1_024, MAX_OUTPUT_TOKENS);
  if (defaultMaxTokens > MAX_OUTPUT_TOKENS) throw new Error("NVIDIA_MAX_TOKENS exceeds the hard ceiling.");
  return {
    allowedModels,
    baseUrl: normalizeBaseUrl(env.NVIDIA_BASE_URL),
    defaultMaxTokens,
    concurrency: positiveInt(env.NVIDIA_CONCURRENCY, DEFAULT_CONCURRENCY, MAX_CONCURRENCY_CAP),
    budgetCalls: positiveInt(env.NVIDIA_BUDGET_CALLS, DEFAULT_BUDGET_CALLS, MAX_BUDGET_CALLS_CAP),
    budgetTokens: positiveInt(env.NVIDIA_BUDGET_TOKENS, DEFAULT_BUDGET_TOKENS, MAX_BUDGET_TOKENS_CAP),
  };
}

/** The one authority on whether a model may run: exact match on the deployment allowlist. */
export function allowedModel(policy: NvidiaPolicy, model: string): string {
  if (typeof model !== "string" || model.length > 256 || !/^[\w./:@+-]+$/.test(model)) {
    throw new Error("Invalid model identifier.");
  }
  if (!policy.allowedModels.has(model)) {
    throw new Error("Model is outside the deployment allowlist.");
  }
  return model;
}

export function boundedText(value: string, max: number, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be text.`);
  if (value.length > max) throw new Error(`${name} exceeds the ${max}-character limit.`);
  return value;
}

// ---------------------------------------------------------------------------
// Image parts (OpenAI-compatible data URIs), strictly bounded

const DATA_URI = /^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=]+)$/;

export interface ImagePart {
  /** The validated data URI (content type + base64), ready for the wire. */
  dataUri: string;
  /** Base64 character length, for budget accounting. */
  base64Chars: number;
}

/**
 * Validates one image part: an `image/<allowed-type>` data URI whose base64 payload is within
 * the per-part ceiling. Content is never decoded or interpreted here — the shape check and the
 * byte ceilings are the boundary.
 */
export function validateImagePart(raw: unknown, partIndex: number): ImagePart {
  if (typeof raw !== "string") throw new Error(`Image part ${partIndex} must be a base64 data URI (png, jpeg, webp, or gif).`);
  const match = DATA_URI.exec(raw);
  if (!match) throw new Error(`Image part ${partIndex} must be a base64 data URI (png, jpeg, webp, or gif).`);
  const [, , base64] = match;
  if (base64.length > MAX_IMAGE_PART_CHARS) {
    throw new Error(`Image part ${partIndex} exceeds the ${MAX_IMAGE_PART_CHARS}-base64-character limit.`);
  }
  return { dataUri: raw, base64Chars: base64.length };
}

/** Sums image-part base64 lengths; refuses when the request total crosses the ceiling. */
export function totalImageBudget(parts: ImagePart[]): number {
  const total = parts.reduce((a, p) => a + p.base64Chars, 0);
  if (total > MAX_IMAGE_TOTAL_CHARS) throw new Error(`Images exceed the ${MAX_IMAGE_TOTAL_CHARS}-base64-character request limit.`);
  return total;
}

/** Typed usage with honest unknowns: cost is null unless a price is known. */
export interface ComputeUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  /** Microunits of USD; null when no trustworthy price exists — never zero-fabricated. */
  costMicrousd: number | null;
}
