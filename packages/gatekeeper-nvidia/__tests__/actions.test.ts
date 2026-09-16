// The Gatekeeper DO imports cloudflare:workers, which does not resolve under the plain node test
// pool. These tests exercise the vendor surface through source-level contracts, the established
// pattern in this repository. The policy itself (allowlist, image parts, budget caps) is proven
// behaviorally in policy.test.ts.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/nvidia.ts", import.meta.url), "utf8");

function extractClass(name: string): string {
  const start = source.indexOf(`class ${name}`);
  if (start < 0) throw new Error(`class ${name} not found`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") { depth--; if (depth === 0) return source.slice(start, i + 1); }
  }
  throw new Error(`class ${name} is unterminated`);
}

describe("NVIDIA durable account", () => {
  const gatekeeper = extractClass("NvidiaGatekeeper");

  it("enforces the compute allowance before every dispatch and settles honest usage", () => {
    expect(gatekeeper).toContain("async #reserve(): Promise<void>");
    expect(gatekeeper).toContain("budget.callsRemaining < 1");
    expect(gatekeeper).toContain("budget.tokensRemaining < 1");
    // Actual usage settles from the vendor's usage block; unknown usage is never fabricated.
    expect(gatekeeper).toContain("if (usage.totalTokens !== null)");
    expect(gatekeeper).toContain("#settleUnknownUsage");
  });

  it("gates concurrent calls and refuses compute-only write actions", () => {
    expect(gatekeeper).toContain("new CallGate(nvidiaPolicy(env).concurrency)");
    expect(gatekeeper).toContain("NVIDIA surfaces compute only; there are no approval-queue write actions.");
  });
});

describe("NVIDIA session policy", () => {
  const session = extractClass("NvidiaSessionImpl");

  it("runs every compute call behind the model allowlist and an authorized observation", () => {
    expect(session).toContain("allowedModel(policy, model)");
    expect(session).toContain("authorizeObservation");
    expect(session).toContain("List NVIDIA models");
  });

  it("validates image parts and enforces the request-total ceiling", () => {
    expect(session).toContain("validateImagePart(part.imageDataUri");
    expect(session).toContain("totalImageBudget(imageParts)");
    // The multimodal wire shape is OpenAI-compatible image_url parts.
    expect(session).toContain('type: "image_url"');
  });

  it("bounds output honestly: caps at 1 MiB and reports truncation from the finish reason", () => {
    expect(session).toContain("capped ? text.slice(0, MAX_OUTPUT_CHARS) : text");
    expect(session).toContain("usage.completionTokens >= maxTokens");
    // Cost is never fabricated: typed usage carries the honest null (the usage mapper).
    expect(source).toContain("costMicrousd: null");
  });

  it("bounds embeddings and reranking structurally", () => {
    expect(session).toContain("Embedding requires at most");
    expect(session).toContain("Reranking requires 1-");
    expect(session).toContain("out-of-range index");
  });
});

describe("NVIDIA agent-facing types", () => {
  it("keeps types-code.ts hand-synced with types.d.ts", () => {
    const declarations = readFileSync(new URL("../src/types.d.ts", import.meta.url), "utf8");
    const code = readFileSync(new URL("../src/types-code.ts", import.meta.url), "utf8");
    for (const marker of [
      "getBudget(): Promise<NvidiaBudget>",
      "rerank(model: string, query: string, documents: string[], options?: NvidiaRerankOptions): Promise<NvidiaRerankResult>",
      "NvidiaMessagePart = NvidiaTextPart | NvidiaImagePart",
      "costMicrousd: number | null",
    ]) {
      expect(declarations).toContain(marker);
      expect(code).toContain(marker);
    }
  });
});
