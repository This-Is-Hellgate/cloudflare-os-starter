import { describe, expect, it } from "vitest";

// The Gatekeeper DO imports cloudflare:workers, which does not resolve under the plain node
// test pool. These tests exercise the vendor surface through source-level contracts. The durable
// action state machine itself (sequential ids, staged-before-submit, retire-not-delete, live+retired
// lookups, idempotent apply) now lives in @gadgets/stage and is tested behaviorally there; these
// assertions pin the delegation and the vendor-specific policy that stays in this package.

import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/snowflake.ts", import.meta.url), "utf8");

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

describe("Snowflake durable action model", () => {
  const gatekeeper = extractClass("SnowflakeGatekeeper");

  it("delegates the action ledger to the shared Stage", () => {
    expect(gatekeeper).toContain('new Stage<SnowflakeWriteAction>({ kv: this.ctx.storage.kv, label: "Snowflake" })');
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
    expect(gatekeeper).toContain("Snowflake action executor is not enabled.");
  });

  it("maps stored records onto the public write proposal", () => {
    expect(gatekeeper).toContain("simulated: true");
    expect(gatekeeper).toContain("findWriteByProposalId");
  });
});

describe("Snowflake write proposal policy", () => {
  const session = extractClass("SessionImpl");

  it("requires a fully-qualified write target", () => {
    expect(session).toContain("Write target must be DATABASE.SCHEMA.TABLE.");
  });

  it("restricts proposals to the declared operation and forbids destructive keywords", () => {
    expect(session).toContain("Only bounded INSERT, UPDATE, or MERGE proposals are permitted.");
    expect(session).toContain("new RegExp(`^${operation}");
    expect(session).toMatch(/DROP\|TRUNCATE\|ALTER\|CREATE\|GRANT\|REVOKE\|CALL\|DELETE/);
  });

  it("bounds the SQL proposal size", () => {
    expect(session).toContain("SQL proposal exceeds the size limit.");
  });

  it("submits a human-decision description and rolls back the staged record on failure", () => {
    expect(session).toContain("It will run only if this action is approved.");
    expect(session).toContain("discardStagedWrite");
    expect(session).toContain("markWritePending");
  });

  it("returns the durable actionId on the proposal", () => {
    expect(session).toContain("actionId");
  });
});
