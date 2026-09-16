import { describe, expect, it } from "vitest";

// The Gatekeeper DO imports cloudflare:workers, which does not resolve under the plain node
// test pool. These tests exercise the vendor surface through source-level contracts. The durable
// action state machine itself (sequential ids, staged-before-submit, retire-not-delete, live+retired
// lookups, idempotent apply) now lives in @gadgets/stage and is tested behaviorally there; these
// assertions pin the delegation, the executor gate, and the vendor-specific policy split between
// this package's implementation and its pure policy module.

import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/snowflake.ts", import.meta.url), "utf8");
const policySource = readFileSync(new URL("../src/policy.ts", import.meta.url), "utf8");

function extractClass(name: string, src: string = source): string {
  const start = src.indexOf(`class ${name}`);
  if (start < 0) throw new Error(`class ${name} not found`);
  const bodyStart = src.indexOf("{", start);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`class ${name} is unterminated`);
}

describe("Snowflake durable action model", () => {
  const gatekeeper = extractClass("SnowflakeGatekeeper");

  it("delegates the action ledger to the shared Stage", () => {
    expect(gatekeeper).toContain('new Stage<SnowflakeWriteAction>({ kv: this.ctx.storage.kv, label: "Snowflake" })');
    // The trusted subject is bound at staging time — the DO rebuilds it from its own context,
    // never from session arguments.
    expect(gatekeeper).toContain("this.#stage.stage(action, subject)");
    expect(gatekeeper).toContain("this.#stage.markPending(actionId)");
    expect(gatekeeper).toContain("this.#stage.discardStaged(actionId)");
    expect(gatekeeper).toContain("this.#stage.reject(actionId)");
    expect(gatekeeper).toContain("this.#stage.findByProposalId(proposalId)");
  });

  it("delegates the gated write lifecycle to the shared runtime", () => {
    expect(gatekeeper).toContain('new GatedActions(this.#stage, "Snowflake", this.#journal)');
    // applyAction is the overseer's entry point; idempotency and state gating live in
    // @gadgets/stage and are tested behaviorally there.
    expect(gatekeeper).toContain("this.#gated.apply(actionId, {");
    expect(gatekeeper).toContain("writesEnabled: writesEnabled(this.env)");
    // The session-side stage/submit/discard/mark-pending dance lives in proposeAction.
    expect(gatekeeper).not.toMatch(/catch \(error\)/);
  });

  it("refuses to execute while the executor is disabled", () => {
    expect(gatekeeper).toContain("Snowflake action executor is not enabled.");
  });

  it("re-validates the stored payload through the shared policy before executing", () => {
    expect(gatekeeper).toContain("validateWriteProposal(policy, record.operation, record.target, record.sql)");
    expect(gatekeeper).toContain("async #execute(record: StoredSnowflakeAction, _attempt:");
  });

  it("executes the approved DML against the SQL API with the configured role and warehouse", () => {
    expect(gatekeeper).toContain("statement: record.sql");
    expect(gatekeeper).toContain("this.env.SNOWFLAKE_WAREHOUSE ? { warehouse: this.env.SNOWFLAKE_WAREHOUSE }");
  });

  it("executes the approved DML only through the executor callback, whose success the shared runtime records", () => {
    expect(gatekeeper).toContain("statement: record.sql");
    expect(gatekeeper).toContain("this.env.SNOWFLAKE_WAREHOUSE ? { warehouse: this.env.SNOWFLAKE_WAREHOUSE }");
    expect(gatekeeper).toContain("execute: (stored, attempt) => this.#execute(stored, attempt)");
  });

  it("maps stored records onto the public write proposal with honest state", () => {
    expect(gatekeeper).toContain("simulated: record.state !== \"approved\"");
    expect(gatekeeper).toContain("findActionByProposalId");
  });
});

describe("Snowflake write proposal policy", () => {
  const session = extractClass("SessionImpl");

  it("routes fresh proposals through the shared validation authority", () => {
    expect(session).toContain("validateWriteProposal(p, operation, target, sql)");
  });

  it("routes fresh proposals through the shared proposeAction lifecycle", () => {
    expect(session).toContain("proposeAction(this.gatekeeper, this.queue, payload,");
  });

  it("keeps the operation and destructive-keyword rules in the policy module", () => {
    expect(policySource).toContain("Only bounded INSERT, UPDATE, DELETE, MERGE, or plan proposals are permitted.");
    expect(policySource).toContain("new RegExp(`^${operation}");
    expect(policySource).toMatch(/DROP\|TRUNCATE\|ALTER\|CREATE\|GRANT\|REVOKE\|CALL\|DELETE/);
  });

  it("requires a fully-qualified write target", () => {
    expect(policySource).toContain("Write target must be DATABASE.SCHEMA.TABLE.");
  });

  it("bounds the SQL proposal size", () => {
    expect(policySource).toContain("SQL proposal exceeds the size limit.");
  });

  it("submits a human-decision description while the shared runtime rolls back the staged record on failure", () => {
    expect(session).toContain("It will run only if this action is approved.");
    expect(session).toContain("implementsRevert: false");
  });

  it("pauses the agent until the human decision lands (writes are not simulated)", () => {
    expect(session).toContain("awaitDecision: true");
  });

  it("returns the durable actionId on the proposal", () => {
    expect(session).toContain("actionId");
  });
});

describe("Snowflake API and capability surface", () => {
  it("sends the configured role explicitly on every statement", () => {
    expect(source).toContain("role: this.env.SNOWFLAKE_ROLE");
  });

  it("authenticates with a bearer token against the account SQL API", () => {
    expect(source).toContain("/api/v2/statements");
    expect(source).toContain("SNOWFLAKE_TOKEN");
  });

  it("targets the Cortex Analyst and Search endpoints", () => {
    expect(source).toContain("/api/v2/cortex/analyst/message");
    expect(source).toContain("cortex-search-services");
    expect(source).toContain("semantic_view: view");
  });

  it("fails closed when Cortex allowlists are not configured", () => {
    expect(source).toContain("SNOWFLAKE_CORTEX_SEMANTIC_VIEWS");
    expect(source).toContain("SNOWFLAKE_CORTEX_SEARCH_SERVICES");
  });

  it("narrows the live database catalog by the configured allowlist", () => {
    expect(source).toContain('metadata("SHOW DATABASES")');
    expect(source).toContain("p.databases.has(d.name.toUpperCase())");
  });

  it("guards read-only SQL with the bounded SELECT policy", () => {
    // Statement validation is shared by both query forms via the pure boundedSelect module.
    expect(source).toContain('from "./sql-pages.js"');
    expect(source).toContain("boundedSelect(sql)");
    expect(source).toContain("allowed(p.databases, options.database, \"Database\")");
  });

  it("exposes partitioned results as a live capability within the cumulative budgets", () => {
    expect(source).toContain("runReadOnlySqlPages");
    // The walk delegates to the shared cursor runtime and the verified partition contract.
    expect(source).toContain('from "@gadgets/cursor"');
    expect(source).toContain("partitionPager(");
    expect(source).toContain("api.partition(first.statementHandle ?? first.queryId, partition)");
    // Same cumulative budgets and allowlist checks as the single-shot form; pages re-authorize.
    expect(source).toContain("maxRows: p.maxRows, maxBytes: p.maxBytes");
    expect(source).toContain("maxPages: p.maxResultPages");
    expect(source).toContain("Read Snowflake query result pages");
    // The single-shot form is preserved unchanged.
    expect(source).toContain("api().sql(sql, options, p.maxRows, p.maxBytes)");
  });

  it("keeps types-code.ts hand-synced with types.d.ts", () => {
    const declarations = readFileSync(new URL("../src/types.d.ts", import.meta.url), "utf8");
    const code = readFileSync(new URL("../src/types-code.ts", import.meta.url), "utf8");
    for (const marker of ["proposeWrite(operation: \"insert\" | \"update\" | \"merge\", target: string, sql: string): Promise<SnowflakeWriteProposal>", "getWriteProposal(proposalId: string): Promise<SnowflakeWriteProposal | null>", "runReadOnlySql(sql: string, options: ReadOnlySqlOptions): Promise<ReadOnlySqlResult>", "runReadOnlySqlPages(sql: string, options: ReadOnlySqlOptions): Promise<ReadOnlySqlPages>", "cortexAnalyst(request: CortexAnalystRequest): Promise<CortexAnalystResult>"]) {
      expect(declarations).toContain(marker);
      expect(code).toContain(marker);
    }
  });
});
