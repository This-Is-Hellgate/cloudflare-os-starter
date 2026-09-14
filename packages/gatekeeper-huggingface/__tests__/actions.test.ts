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

  it("delegates the gated write lifecycle to the shared runtime", () => {
    expect(gatekeeper).toContain('new GatedActions(this.#stage, "Hugging Face")');
    // applyAction is the overseer's entry point; idempotency and state gating live in
    // @gadgets/stage and are tested behaviorally there.
    expect(gatekeeper).toContain("this.#gated.apply(actionId, {");
    expect(gatekeeper).toContain("writesEnabled: writesEnabled(this.env)");
  });

  it("refuses to execute while the executor is disabled", () => {
    expect(gatekeeper).toContain("Hugging Face write application is disabled until the action executor is enabled.");
    expect(gatekeeper).toContain("writesEnabled: writesEnabled(this.env)");
    // Approval is recorded by the shared runtime only after the executor succeeds.
    expect(gatekeeper).toContain("execute: (record) => this.#execute(record)");
  });

  it("executes approved actions only after verification of the stored payload", () => {
    expect(gatekeeper).toContain("Stored commit payload is invalid.");
    expect(gatekeeper).toContain("Stored comment payload is invalid.");
    expect(gatekeeper).toContain("Stored Space payload does not match the bound resource.");
  });

  it("maps stored records onto the public write proposal", () => {
    expect(gatekeeper).toContain("simulated: record.state !== \"approved\"");
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

  it("submits a human-decision description while the shared runtime rolls back the staged record on failure", () => {
    expect(session).toContain("It will be applied only if this action is approved.");
    expect(session).toContain("proposeAction(this.gatekeeper, this.queue, payload,");
  });

  it("returns the durable actionId on the proposal", () => {
    expect(session).toContain("actionId");
  });

  it("queries datasets through the bounded datasets-server backend", () => {
    expect(session).toContain("https://datasets-server.huggingface.co/rows");
    expect(session).toContain("boundedInt(options?.maxRows, 100, 1000)");
  });

  it("returns a real Cap'n Web cursor for discussion listings", () => {
    expect(session).toContain("new ArrayCursor<DiscussionSummary>(items)");
  });

  it("routes governed inference through the router with bounded output", () => {
    expect(session).toContain("https://router.huggingface.co/v1/chat/completions");
    expect(session).toContain("capOutput");
  });
});

describe("Hugging Face agent-facing types", () => {
  it("keeps types-code.ts hand-synced with types.d.ts", () => {
    const declarations = readFileSync(new URL("../src/types.d.ts", import.meta.url), "utf8");
    const code = readFileSync(new URL("../src/types-code.ts", import.meta.url), "utf8");
    for (const marker of ["actionId: number", "getWriteProposal(proposalId: string): Promise<WriteProposal | null>", "getDiscussion(number: number): Promise<HuggingFaceDiscussionDetail>", "HuggingFaceDiscussionDetail extends DiscussionSummary"]) {
      expect(declarations).toContain(marker);
      expect(code).toContain(marker);
    }
  });
});
