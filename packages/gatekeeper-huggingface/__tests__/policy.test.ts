import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Hugging Face Gatekeeper policy", () => {
  const source = readFileSync(new URL("../src/huggingface.ts", import.meta.url), "utf8");
  it("keeps the approved high-risk surfaces disabled", () => {
    expect(source).toContain("HF_RESOURCE_URL");
    expect(source).toContain("Hugging Face write application is disabled");
    expect(source).toContain("Dataset queries require an approved dataset query backend");
    expect(source).toContain("Hugging Face configurator is not enabled yet");
    expect(source).not.toContain("R2");
    expect(source).not.toContain("MCP");
  });
});
