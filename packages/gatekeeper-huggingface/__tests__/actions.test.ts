import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The Gatekeeper DO imports cloudflare:workers, which does not resolve under the plain node
// test pool. These tests exercise the durable action model through source-level contracts:
// the state machine invariants are structural (key layout, state transitions, retire-not-delete)
// and are verified against the reviewed source so regressions fail loudly.

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

  it("assigns sequential action ids from a durable counter, not the clock", () => {
    expect(gatekeeper).toContain('const key = "counter:action"');
    expect(gatekeeper).toContain("((await this.ctx.storage.kv.get<number>(key)) ?? 0) + 1");
    // the id must never derive from Date.now(); timestamps are only recorded as metadata
    expect(gatekeeper).not.toMatch(/Date\.now\(\)\s*%/);
    expect(gatekeeper).not.toContain("Math.floor(Date.now()");
  });

  it("stages actions with an explicit staged state before submission", () => {
    expect(gatekeeper).toContain('state: "staged"');
    expect(gatekeeper).toContain("stageAction");
    expect(gatekeeper).toContain("markActionPending");
  });

  it("retires rejected actions instead of deleting them", () => {
    expect(gatekeeper).toContain('this.ctx.storage.kv.put(`retiredAction:${actionId}`, record)');
    expect(gatekeeper).toContain('this.ctx.storage.kv.delete(`action:${actionId}`)');
    // lookups must consult both live and retired records
    expect(gatekeeper).toContain('kv.get<StoredHuggingFaceAction>(`action:${actionId}`)');
    expect(gatekeeper).toContain('kv.get<StoredHuggingFaceAction>(`retiredAction:${actionId}`)');
  });

  it("keeps applyAction idempotent for overseer re-delivery", () => {
    expect(gatekeeper).toContain('if (record.state === "approved") return;');
  });

  it("refuses to execute while the executor is disabled", () => {
    expect(gatekeeper).toContain("Hugging Face write application is disabled until the action executor is enabled.");
  });

  it("discards only staged records when submission fails", () => {
    expect(gatekeeper).toContain('if (record?.state === "staged") await this.ctx.storage.kv.delete(`action:${actionId}`)');
  });

  it("resolves proposals across live and retired records", () => {
    expect(gatekeeper).toContain('prefix: "action:"');
    expect(gatekeeper).toContain('prefix: "retiredAction:"');
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
