import { describe, expect, it } from "vitest";

// The Gatekeeper DO imports cloudflare:workers, which does not resolve under the plain node
// test pool. These tests exercise the vendor surface through source-level contracts. The durable
// action state machine itself (sequential ids, staged-before-submit, retire-not-delete, live+retired
// lookups, idempotent apply) now lives in @gadgets/stage and is tested behaviorally there; these
// assertions pin the delegation and the vendor-specific policy that stays in this package.

import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/huggingface.ts", import.meta.url), "utf8");

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

describe("Hugging Face durable action model", () => {
  const gatekeeper = extractClass("HuggingFaceGatekeeper");

  it("delegates the action ledger to the shared Stage", () => {
    expect(gatekeeper).toContain('new Stage<HuggingFaceWriteAction>({ kv: this.ctx.storage.kv, label: "Hugging Face" })');
    expect(gatekeeper).toContain("this.#stage.stage(action)");
    expect(gatekeeper).toContain("this.#stage.markPending(actionId)");
    expect(gatekeeper).toContain("this.#stage.discardStaged(actionId)");
    expect(gatekeeper).toContain("this.#stage.reject(actionId)");
    expect(gatekeeper).toContain("this.#stage.findByProposalId(proposalId)");
  });

  it("keeps applyAction idempotent for overseer re-delivery", () => {
    expect(gatekeeper).toContain('if (record.state === "approved") return;');
  });

  it("refuses to execute while the executor is disabled", () => {
    expect(gatekeeper).toContain("Hugging Face write application is disabled until the action executor is enabled.");
  });

  it("maps stored records onto the public write proposal", () => {
    expect(gatekeeper).toContain("simulated: true");
    expect(gatekeeper).toContain("findActionByProposalId");
  });
});

describe("Hugging Face proposal policy", () => {
  const session = extractClass("HuggingFaceSessionImpl");

  it("bounds commit size and rejects path traversal", () => {
    expect(session).toContain("A commit requires 1–50 changes.");
    expect(session).toContain('c.path.includes("..")');
    expect(session).toContain('c.path.startsWith("/")');
  });

  it("bounds discussion and comment payloads", () => {
    expect(session).toContain("boundedString(title, 300");
    expect(session).toContain("boundedString(body, 20_000");
  });

  it("restricts Space state changes to bound Spaces", () => {
    expect(session).toContain("Space state changes require a bound Space.");
  });

  it("submits a human-decision description and rolls back the staged record on failure", () => {
    expect(session).toContain("It will be applied only if this action is approved.");
    expect(session).toContain("discardStagedAction");
    expect(session).toContain("markActionPending");
  });

  it("returns the durable actionId on the proposal", () => {
    expect(session).toContain("actionId");
  });
});

describe("Hugging Face agent-facing types", () => {
  it("keeps types-code.ts hand-synced with types.d.ts", () => {
    const declarations = readFileSync(new URL("../src/types.d.ts", import.meta.url), "utf8");
    const code = readFileSync(new URL("../src/types-code.ts", import.meta.url), "utf8");
    for (const marker of ["actionId: number", "getWriteProposal(proposalId: string): Promise<WriteProposal | null>"]) {
      expect(declarations).toContain(marker);
      expect(code).toContain(marker);
    }
  });
});
