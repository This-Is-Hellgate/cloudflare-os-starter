// The governed Snowflake write grammar: structured mutation plans, their expression/predicate
// trees, the deterministic Snowflake SQL compiler with server-side bindings, and the policy
// validation shared by fresh proposals and the approved-action executor.
//
// Design invariants:
//  - The plan IS the approval: it is normalized and hashed; the compiled SQL is a pure function
//    of it, so approved semantics and executed bytes cannot diverge.
//  - Values never interpolate into SQL text. Every scalar rides a `?` placeholder mapped to a
//    typed server-side binding — the injection surface is zero by construction.
//  - Identifiers are validated and uppercased (Snowflake unquoted-identifier rules); every
//    target carries exactly DATABASE.SCHEMA.TABLE.
//  - Predicates are closed-world: comparisons, null checks, IN over bound values, bounded
//    AND/OR/NOT groups. Expressions are literal | column | arithmetic | allowlisted calls | CASE.
//    Subqueries, dynamic SQL, and DDL are not part of the grammar; the parser refuses them.
//
// This module is free of `cloudflare:workers` imports so the fixtures drive the real compiler.

import type { SnowflakePolicy } from "./policy.js";
import { allowed, identifier, MAX_SQL } from "./policy.js";

/** Bound structural limits: a deployment may not raise these. */
export const MAX_PLAN_STEPS = 10;
export const MAX_COLUMNS = 64;
export const MAX_PLAN_ROWS = 1_000;
export const MAX_IN_VALUES = 100;
export const MAX_PRED_DEPTH = 4;
export const MAX_GROUP_PARTS = 8;
export const MAX_CALL_ARGS = 4;
export const MAX_CASE_WHENS = 8;
export const MAX_ASSIGNMENTS = 64;
export const MAX_EXPR_NODES = 200;
export const MAX_INSERT_SELECT_CHARS = 8_000;
/** Default affected-row ceiling for predicate-based mutations; operators may lower it. */
export const DEFAULT_MAX_ROWS = 1_000;
/** Hard ceiling on any declared affected-row bound. */
export const MAX_MAX_ROWS = 100_000;

export type Scalar = string | number | boolean | null;

export interface ColumnRef {
  kind: "column";
  /** Validated identifier; in a MERGE, `source: true` refers to the source alias. */
  name: string;
  source?: boolean;
}
export interface LiteralExpr { kind: "literal"; value: Scalar }
export interface BinaryExpr { kind: "binary"; op: "+" | "-" | "*" | "/" | "%" | "||"; left: Expr; right: Expr }
export interface CallExpr { kind: "call"; fn: string; args: Expr[] }
export interface CaseExpr { kind: "case"; whens: { when: Pred; result: Expr }[]; else?: Expr }
export type Expr = LiteralExpr | ColumnRef | BinaryExpr | CallExpr | CaseExpr;

export interface ComparePred { kind: "compare"; op: "=" | "!=" | "<" | "<=" | ">" | ">="; left: Expr; right: Expr }
export interface NullPred { kind: "nullCheck"; expr: Expr; negated: boolean }
export interface InPred { kind: "in"; expr: Expr; values: Scalar[] }
export interface GroupPred { kind: "and" | "or"; parts: Pred[] }
export interface NotPred { kind: "not"; part: Pred }
export type Pred = ComparePred | NullPred | InPred | GroupPred | NotPred;

export interface InsertPlan {
  operation: "insert";
  target: string;
  columns: string[];
  rows: Expr[][];
  maxRows: number;
}
export interface UpdatePlan {
  operation: "update";
  target: string;
  assignments: { column: string; value: Expr }[];
  where: Pred;
  maxRows: number;
}
export interface DeletePlan {
  operation: "delete";
  target: string;
  where: Pred;
  maxRows: number;
}
export interface MergePlan {
  operation: "merge";
  target: string;
  /** Bound source rows; the compiled statement materializes them server-side. */
  source: { columns: string[]; rows: Expr[][] };
  on: Pred;
  matched?: { assignments: { column: string; value: Expr }[] };
  notMatched?: { columns: string[]; values: Expr[] };
  maxRows: number;
}
export interface InsertSelectPlan {
  operation: "insert_select";
  target: string;
  columns: string[];
  /** Bounded SELECT text, executed through the read role's RBAC; rows materialize then bind. */
  select: string;
  maxRows: number;
  maxBytes: number;
}
export type Mutation = InsertPlan | UpdatePlan | DeletePlan | MergePlan | InsertSelectPlan;
export interface PlanStep { mutation: Mutation }
export interface MultiStepPlan {
  operation: "plan";
  steps: PlanStep[];
}
export type WritePlan = Mutation | MultiStepPlan;

/** One compiled statement: canonical SQL plus its typed server-side bindings. */
export interface CompiledStatement {
  sql: string;
  /** Snowflake SQL API bindings: placeholder index -> typed value. */
  bindings: Record<string, { type: string; value: string | boolean | null }>;
  /** Declared affected-row ceiling (insert/insert rows are hard-counted; predicate mutations advisory). */
  maxRows: number;
  /** Bounded COUNT(*) preflight for predicate mutations (advisory; the race is documented). */
  preflight?: { sql: string; bindings: Record<string, { type: string; value: string | boolean | null }> };
}

// ---------------------------------------------------------------------------
// Compilation

export const WRITE_FUNCTIONS = new Set([
  "UPPER", "LOWER", "LENGTH", "LEFT", "RIGHT", "TRIM", "CONCAT", "COALESCE",
  "ABS", "ROUND", "FLOOR", "CEIL", "MOD", "NULLIF", "CAST",
]);
const CAST_TYPES = new Set(["NUMBER", "DECIMAL", "VARCHAR", "STRING", "CHAR", "BOOLEAN", "DATE", "TIME", "TIMESTAMP"]);

class Compile {
  sql = "";
  readonly bindings: Record<string, { type: string; value: string | boolean | null }> = {};
  nodes = 0;
  constructor(readonly functions: Set<string>) {}

  #bind(value: Scalar): string {
    const index = Object.keys(this.bindings).length + 1;
    this.bindings[String(index)] = encodeBinding(value);
    return "?";
  }

  /** Emits an expression. `table` forbids column refs (INSERT VALUES); source refs are MERGE-only. */
  expr(node: Expr, allowColumns: boolean, depth = 0): string {
    this.nodes += 1;
    if (this.nodes > MAX_EXPR_NODES || depth > MAX_PRED_DEPTH + 2) throw new Error("Write expression exceeds the structural bound.");
    switch (node.kind) {
      case "literal":
        return this.#bind(node.value);
      case "column":
        if (!allowColumns) throw new Error("INSERT VALUES cannot reference table columns.");
        return node.source ? `SRC.${identifier(node.name, "column")}` : identifier(node.name, "column");
      case "binary": {
        const op = node.op === "||" ? "||" : node.op;
        return `(${this.expr(node.left, allowColumns, depth + 1)} ${op} ${this.expr(node.right, allowColumns, depth + 1)})`;
      }
      case "call": {
        const fn = node.fn.toUpperCase();
        if (!/^[A-Z][A-Z0-9_]*$/.test(fn) || !this.functions.has(fn)) throw new Error(`Function ${fn} is not on the configured write-function allowlist.`);
        if (node.args.length < 1 || node.args.length > MAX_CALL_ARGS) throw new Error(`Function ${fn} requires 1–${MAX_CALL_ARGS} arguments.`);
        const args = node.args.map((a) => this.expr(a, allowColumns, depth + 1));
        if (fn === "CAST") {
          if (args.length !== 2) throw new Error("CAST requires an expression and a type name.");
          const typeNode = node.args[1];
          const type = typeNode.kind === "literal" && typeof typeNode.value === "string" ? typeNode.value.toUpperCase() : "";
          if (!CAST_TYPES.has(type)) throw new Error(`CAST type must be one of ${[...CAST_TYPES].join(", ")}.`);
          return `CAST(${args[0]} AS ${type})`;
        }
        return `${fn}(${args.join(", ")})`;
      }
      case "case": {
        if (node.whens.length < 1 || node.whens.length > MAX_CASE_WHENS) throw new Error(`CASE requires 1–${MAX_CASE_WHENS} branches.`);
        const branches = node.whens.map((w) => `WHEN ${this.pred(w.when, allowColumns, depth + 1)} THEN ${this.expr(w.result, allowColumns, depth + 1)}`);
        const fallback = node.else === undefined ? "" : ` ELSE ${this.expr(node.else, allowColumns, depth + 1)}`;
        return `CASE ${branches.join(" ")}${fallback} END`;
      }
    }
  }

  pred(node: Pred, allowColumns: boolean, depth = 0): string {
    this.nodes += 1;
    if (this.nodes > MAX_EXPR_NODES || depth > MAX_PRED_DEPTH) throw new Error("Write predicate exceeds the structural bound.");
    switch (node.kind) {
      case "compare":
        return `${this.expr(node.left, allowColumns, depth + 1)} ${node.op} ${this.expr(node.right, allowColumns, depth + 1)}`;
      case "nullCheck":
        return `${this.expr(node.expr, allowColumns, depth + 1)} IS ${node.negated ? "NOT " : ""}NULL`;
      case "in": {
        if (node.values.length < 1 || node.values.length > MAX_IN_VALUES) throw new Error(`IN requires 1–${MAX_IN_VALUES} bound values.`);
        const list = node.values.map((v) => this.#bind(v)).join(", ");
        return `${this.expr(node.expr, allowColumns, depth + 1)} IN (${list})`;
      }
      case "and":
      case "or": {
        if (node.parts.length < 1 || node.parts.length > MAX_GROUP_PARTS) throw new Error(`A ${node.kind.toUpperCase()} group requires 1–${MAX_GROUP_PARTS} parts.`);
        const joiner = node.kind === "and" ? " AND " : " OR ";
        return `(${node.parts.map((p) => this.pred(p, allowColumns, depth + 1)).join(joiner)})`;
      }
      case "not":
        return `(NOT ${this.pred(node.part, allowColumns, depth + 1)})`;
    }
  }
}

/** Maps a scalar to its typed SQL API binding (values ride the wire as strings except BOOLEAN). */
export function encodeBinding(value: Scalar): { type: string; value: string | boolean | null } {
  if (value === null) return { type: "TEXT", value: null };
  if (typeof value === "boolean") return { type: "BOOLEAN", value };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Numeric binding must be finite.");
    return Number.isSafeInteger(value) ? { type: "FIXED", value: String(value) } : { type: "REAL", value: String(value) };
  }
  return { type: "TEXT", value };
}

/** The column list, validated and uppercased, in canonical order. */
export function columnList(columns: string[]): string {
  if (!Array.isArray(columns) || columns.length < 1 || columns.length > MAX_COLUMNS) {
    throw new Error(`A column list requires 1–${MAX_COLUMNS} columns.`);
  }
  return columns.map((c) => identifier(c, "column")).join(", ");
}

/** NOT MATCHED insert values may reference literals and SRC columns only. */
function assertSourceOnly(node: Expr, depth: number): void {
  if (depth > MAX_PRED_DEPTH + 2) throw new Error("Write expression exceeds the structural bound.");
  if (node.kind === "column" && !node.source) throw new Error("A NOT MATCHED insert value cannot reference the target table; it must come from the source rows.");
  if (node.kind === "binary") { assertSourceOnly(node.left, depth + 1); assertSourceOnly(node.right, depth + 1); }
  if (node.kind === "call") for (const a of node.args) assertSourceOnly(a, depth + 1);
}

function compileMutation(mutation: Mutation, functions: Set<string>): CompiledStatement {
  const c = new Compile(functions);
  const target = identifier(mutation.target.split(".")[0], "database") + "." +
    identifier(mutation.target.split(".")[1], "schema") + "." + identifier(mutation.target.split(".")[2], "table");
  switch (mutation.operation) {
    case "insert": {
      const columns = columnList(mutation.columns);
      if (mutation.rows.length < 1 || mutation.rows.length > MAX_PLAN_ROWS) throw new Error(`An INSERT requires 1–${MAX_PLAN_ROWS} rows.`);
      const rows = mutation.rows.map((row) => {
        if (!Array.isArray(row) || row.length !== mutation.columns.length) throw new Error("Every INSERT row must carry one value per column.");
        return `(${row.map((e) => c.expr(e, false, 0)).join(", ")})`;
      });
      const sql = `INSERT INTO ${target} (${columns}) VALUES ${rows.join(", ")}`;
      return { sql, bindings: c.bindings, maxRows: mutation.rows.length };
    }
    case "update": {
      if (mutation.assignments.length < 1 || mutation.assignments.length > MAX_ASSIGNMENTS) throw new Error(`An UPDATE requires 1–${MAX_ASSIGNMENTS} assignments.`);
      const sets = mutation.assignments.map((a) => `${identifier(a.column, "column")} = ${c.expr(a.value, true, 0)}`);
      const where = c.pred(mutation.where, true, 0);
      const sql = `UPDATE ${target} SET ${sets.join(", ")} WHERE ${where}`;
      // Advisory preflight: the COUNT race is documented — the ceiling is reviewed, recorded, and
      // checked against the executed row count, but no preflight SELECT guarantees it.
      const pre = new Compile(functions);
      const preflight = { sql: `SELECT COUNT(*) AS N FROM ${target} WHERE ${pre.pred(mutation.where, true, 0)}`, bindings: pre.bindings };
      return { sql, bindings: c.bindings, maxRows: mutation.maxRows, preflight };
    }
    case "delete": {
      const where = c.pred(mutation.where, true, 0);
      const sql = `DELETE FROM ${target} WHERE ${where}`;
      const pre = new Compile(functions);
      const preflight = { sql: `SELECT COUNT(*) AS N FROM ${target} WHERE ${pre.pred(mutation.where, true, 0)}`, bindings: pre.bindings };
      return { sql, bindings: c.bindings, maxRows: mutation.maxRows, preflight };
    }
    case "merge": {
      const source = mutation.source;
      if (!Array.isArray(source.rows) || source.rows.length < 1 || source.rows.length > MAX_PLAN_ROWS) throw new Error(`A MERGE source requires 1–${MAX_PLAN_ROWS} rows.`);
      if (!Array.isArray(source.columns) || source.columns.length < 1 || source.columns.length > MAX_COLUMNS) throw new Error(`A MERGE source requires 1–${MAX_COLUMNS} columns.`);
      const srcCols = columnList(source.columns);
      const selectCols = source.columns.map((_, i) => `column${i + 1}`).join(", ");
      const values = source.rows.map((row) => {
        if (!Array.isArray(row) || row.length !== source.columns.length) throw new Error("Every MERGE source row must carry one value per column.");
        return `(${row.map((e) => c.expr(e, false, 0)).join(", ")})`;
      });
      const on = c.pred(mutation.on, true, 0);
      const clauses: string[] = [];
      if (mutation.matched) {
        if (mutation.matched.assignments.length < 1 || mutation.matched.assignments.length > MAX_ASSIGNMENTS) throw new Error("A matched UPDATE requires 1–64 assignments.");
        clauses.push(`WHEN MATCHED THEN UPDATE SET ${mutation.matched.assignments.map((a) => `${identifier(a.column, "column")} = ${c.expr(a.value, true, 0)}`).join(", ")}`);
      }
      if (mutation.notMatched) {
        const cols = columnList(mutation.notMatched.columns);
        if (mutation.notMatched.values.length !== mutation.notMatched.columns.length) throw new Error("A NOT MATCHED INSERT requires one value per column.");
        // Source-only references: the inserted values come from the bound source rows.
        for (const e of mutation.notMatched.values) assertSourceOnly(e, 0);
        const vals = mutation.notMatched.values.map((e) => c.expr(e, true, 0)).join(", ");
        clauses.push(`WHEN NOT MATCHED THEN INSERT (${cols}) VALUES (${vals})`);
      }
      if (!clauses.length) throw new Error("A MERGE requires a matched or a not-matched clause.");
      const sql = `MERGE INTO ${target} USING (SELECT ${selectCols} FROM (VALUES ${values.join(", ")})) AS SRC (${srcCols}) ON ${on} ${clauses.join(" ")}`;
      return { sql, bindings: c.bindings, maxRows: mutation.maxRows };
    }
    case "insert_select": {
      const select = mutation.select.trim();
      if (!/^SELECT\b/i.test(select)) throw new Error("insert_select requires a SELECT statement.");
      if (select.length > MAX_INSERT_SELECT_CHARS) throw new Error(`The SELECT exceeds the ${MAX_INSERT_SELECT_CHARS}-character bound.`);
      return { sql: select, bindings: c.bindings, maxRows: mutation.maxRows };
    }
  }
}

// ---------------------------------------------------------------------------
// Validation, description, and the public compile entry points

function clampMaxRows(raw: number | undefined): number {
  const n = raw ?? DEFAULT_MAX_ROWS;
  if (!Number.isInteger(n) || n < 1 || n > MAX_MAX_ROWS) throw new Error(`maxRows must be 1-${MAX_MAX_ROWS}.`);
  return n;
}

function normalizeMutation(m: Mutation): Mutation {
  const segments = m.target.split(".");
  if (segments.length !== 3) throw new Error("Write target must be DATABASE.SCHEMA.TABLE.");
  return { ...m, target: identifier(segments[0], "database") + "." + identifier(segments[1], "schema") + "." + identifier(segments[2], "table"), maxRows: clampMaxRows(m.maxRows) };
}

/** The one authority on whether a write plan may run - shared by fresh proposals and the executor's re-validation. */
export function validateWritePlan(policy: SnowflakePolicy, plan: WritePlan): void {
  const mutations = plan.operation === "plan" ? plan.steps.map((s) => s.mutation) : [plan];
  if (mutations.length < 1 || mutations.length > MAX_PLAN_STEPS) throw new Error(`A write plan requires 1-${MAX_PLAN_STEPS} statements.`);
  for (const raw of mutations) {
    const m = normalizeMutation(raw);
    allowed(policy.tables, m.target, "Table");
    switch (m.operation) {
      case "insert": {
        columnList(m.columns);
        if (!Array.isArray(m.rows) || m.rows.length < 1 || m.rows.length > MAX_PLAN_ROWS) throw new Error(`An INSERT requires 1-${MAX_PLAN_ROWS} rows.`);
        break;
      }
      case "update": {
        if (!Array.isArray(m.assignments) || m.assignments.length < 1 || m.assignments.length > MAX_ASSIGNMENTS) throw new Error("An UPDATE requires at least one assignment.");
        if (!m.where) throw new Error("An UPDATE requires a WHERE predicate; empty update predicates are refused.");
        break;
      }
      case "delete": {
        if (!m.where) throw new Error("A DELETE requires a WHERE predicate; unconditional deletes are refused.");
        break;
      }
      case "merge": {
        if (!m.on) throw new Error("A MERGE requires an ON predicate.");
        if (!m.matched && !m.notMatched) throw new Error("A MERGE requires a matched or a not-matched clause.");
        break;
      }
      case "insert_select": {
        if (typeof m.select !== "string" || !(m.select.trim().toUpperCase().startsWith("SELECT"))) throw new Error("insert_select requires a SELECT statement.");
        if (m.select.length > MAX_INSERT_SELECT_CHARS) throw new Error(`The SELECT exceeds the ${MAX_INSERT_SELECT_CHARS}-character bound.`);
        break;
      }
    }
    // Compilation validates the full tree: bounds, allowlisted functions, expression shapes,
    // and the exact canonical SQL the executor will run.
    compileMutation(m, policy.writeFunctions);
  }
}

/** Renders a predicate tree as plain text for the approval summary. */
function predText(pred: Pred, functions: Set<string> = new Set(WRITE_FUNCTIONS)): string {
  const c = new Compile(functions);
  return c.pred(pred, true, 0);
}

/** A human-readable, semantics-first rendering for the approval queue. */
export function describePlan(plan: WritePlan): string {
  const mutations = plan.operation === "plan" ? plan.steps.map((s) => s.mutation) : [plan];
  const lines: string[] = [];
  for (const m of mutations) {
    const op = m.operation.toUpperCase().replace("_", " ");
    lines.push(`${op} on ${m.target} (row ceiling ${m.maxRows})`);
    if (m.operation === "insert") {
      lines.push(`  columns: ${m.columns.map((c) => identifier(c, "column")).join(", ")}`);
      lines.push(`  bound rows: ${m.rows.length}`);
    }
    if (m.operation === "update") lines.push(`  set: ${m.assignments.map((a) => a.column).join(", ")}`);
    if (m.operation === "merge") {
      lines.push(`  bound source rows: ${m.source.rows.length}`);
      if (m.matched) lines.push("  matched: UPDATE");
      if (m.notMatched) lines.push("  not matched: INSERT");
    }
    if (m.operation === "insert_select") lines.push(`  source: bounded SELECT (${m.select.length} chars), materialized through the read role first`);
    if ("where" in m && m.where) lines.push(`  where: ${predText(m.where)}`);
    if (m.operation === "merge" && m.on) lines.push(`  on: ${predText(m.on)}`);
  }
  if (plan.operation === "plan") lines.push("Executes as one ordered plan; stops at the first failed statement. Each statement is journaled separately.");
  return lines.join("\n");
}

/** The executor-facing compilation: each mutation becomes canonical SQL plus server-side bindings. */
export type CompiledWriteStep =
  | { kind: "write"; mutation: Mutation; compiled: CompiledStatement }
  /** The compiled SQL is the SELECT: the executor materializes it through the read role, then builds the INSERT from the bound rows. */
  | { kind: "select"; mutation: InsertSelectPlan; compiled: CompiledStatement };

export function compilePlan(plan: WritePlan, policy: SnowflakePolicy): CompiledWriteStep[] {
  const mutations = plan.operation === "plan" ? plan.steps.map((s) => s.mutation) : [plan];
  return mutations.map((raw): CompiledWriteStep => {
    const m = normalizeMutation(raw);
    const compiled = compileMutation(m, policy.writeFunctions);
    return m.operation === "insert_select" ? { kind: "select", mutation: m as InsertSelectPlan, compiled } : { kind: "write", mutation: m, compiled };
  });
}

/**
 * Builds the INSERT for a materialized select: exact bound rows, server-side bindings, and the
 * approved row ceiling enforced again against what the read actually returned.
 */
export function buildMaterializedInsert(m: InsertSelectPlan, rows: Scalar[][], functions: Set<string>): CompiledStatement {
  return buildMaterializedInsertRows(m.target, m.columns, m.maxRows, rows, functions);
}

export function buildMaterializedInsertRows(target: string, columns: string[], maxRows: number, rows: Scalar[][], functions: Set<string>): CompiledStatement {
  const cols = columnList(columns);
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > maxRows) {
    throw new Error(`The materialized read returned ${Array.isArray(rows) ? rows.length : 0} rows; the approved ceiling is ${maxRows}.`);
  }
  const c = new Compile(functions);
  const tuples = rows.map((row) => {
    if (!Array.isArray(row) || row.length !== columns.length) throw new Error("A materialized row does not match the approved column list.");
    return `(${row.map((v) => c.expr({ kind: "literal", value: v }, false, 0)).join(", ")})`;
  });
  const qualified = target.split(".").map((seg, i) => identifier(seg, ["database", "schema", "table"][i])).join(".");
  const sql = `INSERT INTO ${qualified} (${cols}) VALUES ${tuples.join(", ")}`;
  if (sql.length > MAX_SQL) throw new Error("The generated INSERT exceeds the SQL size limit.");
  return { sql, bindings: c.bindings, maxRows: rows.length };
}
