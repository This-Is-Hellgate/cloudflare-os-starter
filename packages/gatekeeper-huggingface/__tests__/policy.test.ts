import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Hugging Face Gatekeeper policy", () => {
  const source = readFileSync(new URL("../src/huggingface.ts", import.meta.url), "utf8");
  it("keeps the approved high-risk surfaces disabled", () => {
    expect(source).toContain("HF_RESOURCE_URL");
    expect(source).toContain("Hugging Face write application is disabled");
    expect(source).toContain("HF_ENABLE_WRITES");
    expect(source).toContain("Hugging Face configurator is not enabled yet");
    expect(source).not.toContain("R2");
    expect(source).not.toContain("MCP");
  });

  it("queries datasets through the approved bounded datasets-server backend", () => {
    expect(source).toContain("https://datasets-server.huggingface.co/rows");
    expect(source).toContain("https://datasets-server.huggingface.co/splits");
    expect(source).toContain("authorizeObservation");
  });

  it("returns a real Cap'n Web cursor for discussion listings, backed by live paging", () => {
    // Walk mechanics are delegated to @gadgets/cursor; the RPC surface is this package's own
    // transformed RpcTarget, minted inside the governed session flow.
    expect(source).toContain('from "@gadgets/cursor"');
    expect(source).toContain("class HubCursor<T> extends RpcTarget");
    expect(source).toContain("offsetPaged<DiscussionSummary>({");
    // The old in-memory cursor is gone: listings must not be capped by a prefetched array.
    expect(source).not.toContain("class ArrayCursor");
  });

  it("parses the verified discussions response shape, not a bare array", () => {
    // Verified against the live endpoint: the response is { discussions, count, start }.
    expect(source).toContain('(d as any)?.discussions');
    expect(source).toContain("(d as any)?.count ?? 0");
    // Verified: discussion events carry camelCase createdAt.
    expect(source).toContain("e.createdAt");
    expect(source).not.toContain("e.created_at");
  });
});
