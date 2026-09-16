// Task 3.1 focused verification: the governed NVIDIA compute surface.
// Policy bounds (model allowlist, image parts, budget) are proven behaviorally; the session
// wiring is pinned by source-contract assertions (the DO imports cloudflare:workers).
import { describe, expect, it } from "vitest";
import {
  allowedModel, nvidiaPolicy, totalImageBudget, validateApiKey, validateImagePart,
  DEFAULT_BUDGET_CALLS, DEFAULT_BUDGET_TOKENS, DEFAULT_CONCURRENCY, MAX_IMAGE_PART_CHARS,
  MAX_IMAGE_TOTAL_CHARS, MAX_OUTPUT_TOKENS,
} from "../src/policy.js";

function env(overrides: Partial<Record<string, string>> = {}): Env {
  return {
    NVIDIA_API_KEY: "nvapi-test-key-1234567890",
    NVIDIA_ALLOWED_MODELS: "meta/llama-3.1-8b-instruct, nvidia/nv-embedqa-mistral-7b-v2, nvidia/nv-rerankqa-mistral-4b-v3",
    ...overrides,
  } as Env;
}

describe("model allowlist", () => {
  it("allows exact allowlisted models and refuses everything else", () => {
    const policy = nvidiaPolicy(env());
    // NIM model ids are case-sensitive: exact match, no normalization.
    expect(allowedModel(policy, "meta/llama-3.1-8b-instruct")).toBe("meta/llama-3.1-8b-instruct");
    expect(() => allowedModel(policy, "openai/gpt-5")).toThrow(/outside the deployment allowlist/);
    expect(() => allowedModel(policy, "")).toThrow(/Invalid model identifier/);
    expect(() => allowedModel(policy, "model\nnewline")).toThrow(/Invalid model identifier/);
  });

  it("an empty allowlist allows nothing (fail closed)", () => {
    const policy = nvidiaPolicy(env({ NVIDIA_ALLOWED_MODELS: "" }));
    expect(() => allowedModel(policy, "meta/llama-3.1-8b-instruct")).toThrow(/outside the deployment allowlist/);
  });

  it("caps the allowlist size and enforces HTTPS endpoints only", () => {
    expect(() => nvidiaPolicy(env({ NVIDIA_ALLOWED_MODELS: Array.from({ length: 65 }, (_, i) => `m${i}`).join(",") }))).toThrow(/allowlist exceeds/);
    expect(() => nvidiaPolicy(env({ NVIDIA_BASE_URL: "http://integrate.api.nvidia.com" }))).toThrow(/https origin/);
    expect(() => nvidiaPolicy(env({ NVIDIA_BASE_URL: "https://internal.corp/nim" }))).toThrow(/https origin/);
  });

  it("defaults the budget and concurrency, clamping operator misconfiguration", () => {
    const policy = nvidiaPolicy(env());
    expect(policy.budgetCalls).toBe(DEFAULT_BUDGET_CALLS);
    expect(policy.budgetTokens).toBe(DEFAULT_BUDGET_TOKENS);
    expect(policy.concurrency).toBe(DEFAULT_CONCURRENCY);
    expect(nvidiaPolicy(env({ NVIDIA_CONCURRENCY: "99" })).concurrency).toBe(4);
    expect(nvidiaPolicy(env({ NVIDIA_BUDGET_CALLS: "99999999" })).budgetCalls).toBe(100_000);
    // Over-ceiling operator config clamps to the hard maximum, never silently widened beyond it.
    expect(nvidiaPolicy(env({ NVIDIA_MAX_TOKENS: "999999" })).defaultMaxTokens).toBe(MAX_OUTPUT_TOKENS);
  });

  it("sanity-shapes the API key without pretending to validate it", () => {
    expect(validateApiKey("nvapi-key")).toBe("nvapi-key");
    expect(() => validateApiKey(undefined)).toThrow(/not configured/);
    expect(() => validateApiKey("")).toThrow(/not configured/);
    expect(() => validateApiKey("key with space")).toThrow(/not configured/);
  });
});

describe("image parts (the education-material path)", () => {
  const TINY_PNG = "data:image/png;base64,iVBORw0KGgo=";
  const TINY_JPEG = "data:image/jpeg;base64,/9j/4AAQ";

  it("accepts allowed image data URIs within the per-part ceiling", () => {
    const part = validateImagePart(TINY_PNG, 0);
    expect(part.dataUri).toBe(TINY_PNG);
    expect(part.base64Chars).toBeGreaterThan(0);
    expect(validateImagePart(TINY_JPEG, 1).base64Chars).toBeGreaterThan(0);
  });

  it("rejects non-data-URI and disallowed image types", () => {
    for (const bad of [
      "https://example.com/image.png",
      "data:text/html;base64,PGI+",
      "data:image/svg+xml;base64,PHN2Zz4=",
      "data:image/png;base64,not base64!!",
      "not a uri",
      42,
      undefined,
    ]) {
      expect(() => validateImagePart(bad, 0), String(bad)).toThrow(/data URI/);
    }
  });

  it("enforces per-part and total base64 ceilings", () => {
    const oversized = "data:image/png;base64," + "A".repeat(MAX_IMAGE_PART_CHARS + 1);
    expect(() => validateImagePart(oversized, 0)).toThrow(/per-part|base64-character limit/);
    // Three parts each under the per-part cap but over the request total.
    const parts = Array.from({ length: 4 }, () => validateImagePart(`data:image/png;base64,${"A".repeat(MAX_IMAGE_PART_CHARS - 10)}`, 0));
    expect(() => totalImageBudget(parts)).toThrow(/request limit/);
    expect(totalImageBudget([validateImagePart(TINY_PNG, 0)])).toBeLessThan(MAX_IMAGE_TOTAL_CHARS);
  });
});
