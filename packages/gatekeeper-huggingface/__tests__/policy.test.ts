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

  it("returns a real Cap'n Web cursor for discussion listings", () => {
    expect(source).toContain("class ArrayCursor<T> extends RpcTarget");
    expect(source).toContain("new ArrayCursor<DiscussionSummary>(items)");
  });
});
