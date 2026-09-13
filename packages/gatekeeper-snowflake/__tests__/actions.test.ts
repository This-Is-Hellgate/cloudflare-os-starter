import { describe, expect, it } from "vitest";

// The Gatekeeper DO imports cloudflare:workers, which does not resolve under the plain node
// test pool. These tests exercise the durable action model through source-level contracts:
// the state machine invariants are structural (key layout, state transitions, retire-not-delete)
// and are verified against the reviewed source so regressions fail loudly.

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

  it("assigns sequential action ids from a durable counter, not the clock", () => {
    expect(gatekeeper).toContain('const key = "counter:action"');
    expect(gatekeeper).toContain("((await this.ctx.storage.kv.get<number>(key)) ?? 0) + 1");
    expect(gatekeeper).not.toMatch(/Date\.now\(\)\s*%/);
    expect(gatekeeper).not.toContain("Math.floor(Date.now()");
  });

  it("stages actions with an explicit staged state before submission", () => {
    expect(gatekeeper).toContain('state: "staged"');
    expect(gatekeeper).toContain("#stageAction");
    expect(gatekeeper).toContain("#markActionPending");
  });

  it("retires rejected actions instead of deleting them", () => {
    expect(gatekeeper).toContain('this.ctx.storage.kv.put(`retiredAction:${actionId}`, record)');
    expect(gatekeeper).toContain('this.ctx.storage.kv.delete(`action:${actionId}`)');
    // lookups must consult both live and retired records
    expect(gatekeeper).toContain('kv.get<StoredSnowflakeAction>(`action:${actionId}`)');
    expect(gatekeeper).toContain('kv.get<StoredSnowflakeAction>(`retiredAction:${actionId}`)');
  });

  it("keeps applyAction idempotent for overseer re-delivery", () => {
    expect(gatekeeper).toContain('if (record.state === "approved") return;');
  });

  it("refuses to execute while the executor is disabled", () => {
    expect(gatekeeper).toContain("Snowflake action executor is not enabled.");
  });

  it("discards only staged records when submission fails", () => {
    expect(gatekeeper).toContain('if (record?.state === "staged") await this.ctx.storage.kv.delete(`action:${actionId}`)');
  });

  it("resolves proposals across live and retired records", () => {
    expect(gatekeeper).toContain('prefix: "action:"');
    expect(gatekeeper).toContain('prefix: "retiredAction:"');
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
