// Task 1.3 focused verification: the governed write grammar end to end.
// - The plan's key acceptance case: allowlisted table A cannot be paired with SQL for table B;
//   structured compilation and bound values proven in the same fixture.
// - Parse-or-refuse: what the grammar cannot certify is refused with a precise message.
// - Preauthorization matching is DO-side policy, driven by the stored payload.
import { describe, expect, it } from "vitest";
import {
  compilePlan, describePlan, validateWritePlan, buildMaterializedInsertRows, WRITE_FUNCTIONS,
  type WritePlan,
} from "../src/write-plan.js";
import type { SnowflakePolicy } from "../src/policy.js";
import { parseWriteSql } from "../src/write-sql.js";
import { matchesPreauthorization, DEFAULT_WRITE_FUNCTIONS } from "../src/policy.js";

function policy(overrides: Partial<SnowflakePolicy> = {}): SnowflakePolicy {
  return {
    databases: new Set(),
    schemas: new Set(),
    tables: new Set(["APP.SALES.ORDERS"]),
    semanticViews: new Set(),
    searchServices: new Set(),
    maxRows: 1000,
    maxBytes: 2_000_000,
    resultRowsPerPage: 100,
    maxResultPages: 10,
    writeFunctions: new Set(DEFAULT_WRITE_FUNCTIONS),
    preauthorizations: [],
    ...overrides,
  };
}

describe("governed write compilation", () => {
  it("compiles bound values server-side: every literal becomes a placeholder + typed binding", () => {
    const plan: WritePlan = {
      operation: "update",
      target: "APP.SALES.ORDERS",
      assignments: [
        { column: "STATUS", value: { kind: "literal", value: "shipped" } },
        { column: "TOTAL", value: { kind: "binary", op: "*", left: { kind: "column", name: "PRICE" }, right: { kind: "literal", value: 1.1 } } },
      ],
      where: { kind: "in", expr: { kind: "column", name: "ID" }, values: [1, 2, 3] },
      maxRows: 100,
    };
    const [step] = compilePlan(plan, policy());
    expect(step.kind).toBe("write");
    const compiled = step.kind === "write" ? step.compiled : undefined!;
    // Exact target; values ride placeholders; identifiers uppercased per Snowflake rules.
    expect(compiled.sql).toBe("UPDATE APP.SALES.ORDERS SET STATUS = ?, TOTAL = (PRICE * ?) WHERE ID IN (?, ?, ?)");
    expect(compiled.bindings).toEqual({
      "1": { type: "TEXT", value: "shipped" },
      "2": { type: "REAL", value: "1.1" },
      "3": { type: "FIXED", value: "1" },
      "4": { type: "FIXED", value: "2" },
      "5": { type: "FIXED", value: "3" },
    });
    expect(compiled.maxRows).toBe(100);
    // Predicate mutations carry the bounded advisory preflight for the same predicate.
    expect(compiled.preflight?.sql).toBe("SELECT COUNT(*) AS N FROM APP.SALES.ORDERS WHERE ID IN (?, ?, ?)");
    // The preflight covers the predicate only, so its bindings re-index the IN values.
    expect(compiled.preflight?.bindings).toEqual({
      "1": { type: "FIXED", value: "1" },
      "2": { type: "FIXED", value: "2" },
      "3": { type: "FIXED", value: "3" },
    });
  });

  it("compiles merge with materialized source rows and source-only insert values", () => {
    const plan: WritePlan = {
      operation: "merge",
      target: "APP.SALES.ORDERS",
      source: { columns: ["ID", "STATUS"], rows: [[{ kind: "literal", value: 7 }, { kind: "literal", value: "new" }]] },
      on: { kind: "compare", op: "=", left: { kind: "column", name: "ID" }, right: { kind: "column", name: "ID", source: true } },
      matched: { assignments: [{ column: "STATUS", value: { kind: "column", name: "STATUS", source: true } }] },
      notMatched: { columns: ["ID", "STATUS"], values: [{ kind: "column", name: "ID", source: true }, { kind: "column", name: "STATUS", source: true }] },
      maxRows: 500,
    };
    const [step] = compilePlan(plan, policy());
    const compiled = step.kind === "write" ? step.compiled : undefined!;
    expect(compiled.sql).toContain("MERGE INTO APP.SALES.ORDERS USING (SELECT column1, column2 FROM (VALUES (?, ?))) AS SRC (ID, STATUS) ON ID = SRC.ID");
    expect(compiled.sql).toContain("WHEN MATCHED THEN UPDATE SET STATUS = SRC.STATUS");
    expect(compiled.sql).toContain("WHEN NOT MATCHED THEN INSERT (ID, STATUS) VALUES (SRC.ID, SRC.STATUS)");
    expect(compiled.bindings["1"]).toEqual({ type: "FIXED", value: "7" });
  });

  it("describes the plan semantics-first for the approval queue", () => {
    const text = describePlan({
      operation: "delete",
      target: "APP.SALES.ORDERS",
      where: { kind: "compare", op: "=", left: { kind: "column", name: "STAGE" }, right: { kind: "literal", value: "scratch" } },
      maxRows: 250,
    });
    expect(text).toContain("DELETE on APP.SALES.ORDERS (row ceiling 250)");
    expect(text).toContain('where: STAGE = ?');
  });

  it("accepts a multi-step plan and refuses over-limit structure", () => {
    const step = { operation: "insert", target: "APP.SALES.ORDERS", columns: ["A"], rows: [[{ kind: "literal", value: 1 }]], maxRows: 1 };
    const plan: WritePlan = { operation: "plan", steps: [{ mutation: step }, { mutation: step }] };
    expect(() => compilePlan(plan, policy())).not.toThrow();
    const tooMany: WritePlan = { operation: "plan", steps: Array.from({ length: 11 }, () => ({ mutation: step })) };
    expect(() => validateWritePlan(policy(), tooMany)).toThrow(/1-10 statements/);
  });
});

describe("the approval-binding fixture: target cannot drift from SQL", () => {
  it("refuses a proposal whose SQL targets a table outside the allowlist even when the stated target is allowlisted", () => {
    // The stated target is allowlisted APP.SALES.ORDERS; the parsed SQL writes OTHER.SALES.ORDERS.
    const plan = parseWriteSql("UPDATE OTHER.SALES.ORDERS SET STATUS = 'ok' WHERE ID = 1", WRITE_FUNCTIONS);
    expect(() => validateWritePlan(policy(), plan)).toThrow(/outside the configured allowlist/);
  });

  it("compiles the SQL the model proposes to the exact journaled form", () => {
    const sql = "INSERT INTO app.sales.orders (id, note) VALUES (1, 'héllo'), (2, NULL)";
    const plan = parseWriteSql(sql, WRITE_FUNCTIONS);
    validateWritePlan(policy(), plan);
    const [step] = compilePlan(plan, policy());
    const compiled = step.kind === "write" ? step.compiled : undefined!;
    expect(compiled.sql).toBe("INSERT INTO APP.SALES.ORDERS (ID, NOTE) VALUES (?, ?), (?, ?)");
    expect(compiled.bindings["2"]).toEqual({ type: "TEXT", value: "héllo" });
    expect(compiled.bindings["3"]).toEqual({ type: "FIXED", value: "2" });
    expect(compiled.bindings["4"]).toEqual({ type: "TEXT", value: null });
  });

  it("binds INSERT ... SELECT as a materialized read with a hard row ceiling", () => {
    const plan = parseWriteSql("INSERT INTO app.sales.orders (id) SELECT id FROM app.sales.archive", WRITE_FUNCTIONS);
    validateWritePlan(policy(), plan);
    const [step] = compilePlan(plan, policy());
    if (step.kind !== "select") throw new Error("expected a select step");
    expect(step.compiled.sql.toUpperCase()).toBe("SELECT ID FROM APP.SALES.ARCHIVE");
    // The insert is generated only from what the bounded read returned.
    const insert = buildMaterializedInsertRows(step.mutation.target, step.mutation.columns, step.mutation.maxRows, [[1], [2]], WRITE_FUNCTIONS);
    expect(insert.sql).toBe("INSERT INTO APP.SALES.ORDERS (ID) VALUES (?), (?)");
    expect(() => buildMaterializedInsertRows(step.mutation.target, step.mutation.columns, step.mutation.maxRows, Array.from({ length: 1001 }, (_, i) => [i]), WRITE_FUNCTIONS)).toThrow(/approved ceiling/);
  });
});

describe("parse-or-refuse", () => {
  it("refuses DDL, destructive extras, and everything outside the grammar", () => {
    const refusals: [string, RegExp][] = [
      ["DROP TABLE APP.SALES.ORDERS", /INSERT, UPDATE, DELETE, and MERGE/],
      ["TRUNCATE TABLE APP.SALES.ORDERS", /INSERT, UPDATE, DELETE, and MERGE/],
      ["UPDATE APP.SALES.ORDERS SET STATUS = 'ok' WHERE ID = (SELECT 1)", /Subqueries are not part/],
      ["UPDATE APP.SALES.ORDERS SET STATUS = 'ok'", /WHERE predicate/],
      ["DELETE FROM APP.SALES.ORDERS", /WHERE predicate/],
      ["INSERT INTO APP.SALES.ORDERS (ID) VALUES (?)", /Placeholders are not accepted/],
      ['INSERT INTO "Orders" (ID) VALUES (1)', /Quoted identifiers/],
      ["INSERT INTO APP.SALES.ORDERS (ID) VALUES (NOW())", /allowlist/],
      ["INSERT INTO APP.SALES.ORDERS (ID) SELECT ID FROM APP.SALES.ORDERS; DROP TABLE APP.SALES.ORDERS", /INSERT, UPDATE, DELETE, and MERGE/],
    ];
    for (const [sql, message] of refusals) expect(() => parseWriteSql(sql, WRITE_FUNCTIONS), sql).toThrow(message);
  });

  it("splits multiple statements into one ordered plan", () => {
    const plan = parseWriteSql("INSERT INTO APP.SALES.ORDERS (ID) VALUES (1); DELETE FROM APP.SALES.ORDERS WHERE ID = 1", WRITE_FUNCTIONS);
    if (plan.operation !== "plan") throw new Error("expected a plan");
    expect(plan.steps.map((s) => s.mutation.operation)).toEqual(["insert", "delete"]);
  });
});

describe("DO-side preauthorization matching", () => {
  const plan: WritePlan = {
    operation: "insert",
    target: "APP.SALES.ORDERS",
    columns: ["A"],
    rows: [[{ kind: "literal", value: 1 }]],
    maxRows: 100,
  };
  it("matches a narrow pattern and records its name", () => {
    const p = policy({ preauthorizations: [{ name: "routine-events", operations: "insert", target: "APP.SALES.ORDERS", maxRows: 500 }] });
    expect(matchesPreauthorization(p, plan)).toBe("routine-events");
  });
  it("refuses when the ceiling, operation, or target exceeds the pattern", () => {
    const p = policy({ preauthorizations: [{ name: "small-only", operations: "insert", target: "APP.SALES.ORDERS", maxRows: 50 }] });
    expect(matchesPreauthorization(p, plan)).toBeNull();
    const wrongTable = policy({ preauthorizations: [{ name: "other", operations: "insert", target: "APP.SALES.ARCHIVE", maxRows: 500 }] });
    expect(matchesPreauthorization(wrongTable, plan)).toBeNull();
  });
  it("requires every step of a plan to fit the same pattern", () => {
    const other = { ...plan, target: "APP.SALES.ARCHIVE" };
    const multi: WritePlan = { operation: "plan", steps: [{ mutation: plan }, { mutation: other }] };
    const p = policy({ preauthorizations: [{ name: "orders", operations: "insert", target: "APP.SALES.ORDERS", maxRows: 500 }] });
    expect(matchesPreauthorization(p, multi)).toBeNull();
  });
  it("empty configuration means every write takes the queue", () => {
    expect(matchesPreauthorization(policy(), plan)).toBeNull();
  });
});
