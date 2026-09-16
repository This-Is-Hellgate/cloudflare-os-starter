// The SQL adapter for the governed write grammar: parse-or-refuse.
//
// Code Mode programs speak SQL; the governed surface executes plans. This module parses the
// write subset (INSERT / UPDATE / DELETE / MERGE, optionally several statements as one ordered
// plan) into the structured WritePlan that gets approved and journaled. Anything outside the
// grammar — DDL, subqueries in predicates, functions off the allowlist, dynamic SQL — is refused
// with a precise message, never silently reinterpreted. The parsed plan is the authority: the
// executor compiles canonical SQL from it, so what was approved is provably what runs.
//
// Free of `cloudflare:workers` imports so the fixture drives the real parser.

import {
  MAX_CASE_WHENS, MAX_COLUMNS, MAX_GROUP_PARTS, MAX_IN_VALUES, MAX_PLAN_ROWS,
  MAX_PLAN_STEPS, MAX_PRED_DEPTH, DEFAULT_MAX_ROWS,
  type Expr, type Mutation, type Pred, type Scalar, type WritePlan,
} from "./write-plan.js";
import { identifier } from "./policy.js";

/** Hard cap on accepted SQL input (the plan's MAX_SQL covers compiled output). */
const MAX_INPUT_CHARS = 32_000;

type Token =
  | { kind: "word"; value: string; start: number; end: number }
  | { kind: "string"; value: string; start: number; end: number }
  | { kind: "number"; value: number; start: number; end: number }
  | { kind: "punct"; value: string; start: number; end: number }
  | { kind: "param"; value: number; start: number; end: number };

const PUNCT = new Set([",", "(", ")", ".", "=", "<", ">", "+", "-", "*", "/", "%", "|", ";"]);
const MULTI = ["<=", ">=", "!=", "<>", "||"];

/** Tokenizes, stripping comments. Malformed literals/identifiers are parse refusals. */
function tokenize(sql: string): Token[] {
  if (sql.length > MAX_INPUT_CHARS) throw new Error(`Write SQL exceeds the ${MAX_INPUT_CHARS}-character bound.`);
  const tokens: Token[] = [];
  let i = 0;
  let paramIndex = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    if (ch === "-" && sql[i + 1] === "-") { while (i < sql.length && sql[i] !== "\n") i += 1; continue; }
    if (ch === "/" && sql[i + 1] === "*") { const end = sql.indexOf("*/", i + 2); if (end === -1) throw new Error("Unterminated comment in write SQL."); i = end + 2; continue; }
    if (ch === "'") {
      const strStart = i;
      let value = ""; i += 1;
      for (;;) {
        if (i >= sql.length) throw new Error("Unterminated string literal.");
        if (sql[i] === "'") { if (sql[i + 1] === "'") { value += "'"; i += 2; continue; } i += 1; break; }
        value += sql[i]; i += 1;
      }
      tokens.push({ kind: "string", value, start: strStart, end: i });
      continue;
    }
    if (ch === '"') {
      const start = i; i += 1;
      while (i < sql.length && sql[i] !== '"') i += 1;
      if (i >= sql.length) throw new Error("Unterminated quoted identifier.");
      // Quoted (case-preserving) identifiers are outside the governed grammar: normalize is uppercase-only.
      void start; i += 1;
      throw new Error("Quoted identifiers are not part of the governed write grammar; use unquoted names.");
    }
    if (ch === "?") { tokens.push({ kind: "param", value: ++paramIndex, start: i, end: i + 1 }); i += 1; continue; }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(sql[i + 1] ?? ""))) {
      const start = i;
      while (i < sql.length && /[0-9.eE+-]/.test(sql[i])) {
        // Stop +/- that are clearly operators after an exponent or number.
        if ((sql[i] === "+" || sql[i] === "-") && !/[eE]/.test(sql[i - 1])) break;
        i += 1;
      }
      const value = Number(sql.slice(start, i));
      if (!Number.isFinite(value)) throw new Error(`Invalid numeric literal: ${sql.slice(start, i)}`);
      tokens.push({ kind: "number", value, start: start, end: i });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      while (i < sql.length && /[A-Za-z0-9_$]/.test(sql[i])) i += 1;
      tokens.push({ kind: "word", value: sql.slice(start, i), start, end: i });
      continue;
    }
    const two = sql.slice(i, i + 2);
    if (MULTI.includes(two)) { tokens.push({ kind: "punct", value: two === "!=" ? "!=" : two === "<>" ? "!=" : two, start: i, end: i + 2 }); i += 2; continue; }
    if (PUNCT.has(ch)) { tokens.push({ kind: "punct", value: ch, start: i, end: i + 1 }); i += 1; continue; }
    throw new Error(`Unexpected character ${JSON.stringify(ch)} in write SQL.`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser

const RESERVED_NOT_AN_IDENT = new Set([
  "SELECT", "FROM", "WHERE", "SET", "VALUES", "INTO", "USING", "ON", "MATCHED", "NOT", "AND", "OR",
  "IS", "IN", "NULL", "CASE", "WHEN", "THEN", "ELSE", "END", "AS", "DROP", "TRUNCATE", "ALTER",
  "CREATE", "GRANT", "REVOKE", "CALL", "MERGE", "INSERT", "UPDATE", "DELETE", "WITH", "LIMIT",
]);

class Parser {
  #pos = 0;
  #nodes = 0;
  constructor(private readonly source: string, private readonly tokens: Token[], private readonly functions: Set<string>) {}

  #peek(): Token | undefined { return this.tokens[this.#pos]; }
  #next(): Token { const t = this.tokens[this.#pos++]; if (!t) throw new Error("Write SQL ended unexpectedly."); return t; }
  #isWord(value: string): boolean { const t = this.#peek(); return t?.kind === "word" && t.value.toUpperCase() === value; }
  #isPunct(value: string): boolean { const t = this.#peek(); return t?.kind === "punct" && t.value === value; }
  #takeWord(value?: string): string {
    const t = this.#next();
    if (t.kind !== "word" || (value !== undefined && t.value.toUpperCase() !== value)) throw new Error(`Expected ${value ?? "keyword"} in write SQL.`);
    return t.value;
  }
  #takePunct(value: string): void {
    const t = this.#next();
    if (t.kind !== "punct" || t.value !== value) throw new Error(`Expected "${value}" in write SQL.`);
  }
  #optionalWord(value: string): boolean { if (this.#isWord(value)) { this.#pos += 1; return true; } return false; }
  #optionalPunct(value: string): boolean { if (this.#isPunct(value)) { this.#pos += 1; return true; } return false; }
  #end(): void { if (this.#pos < this.tokens.length) throw new Error("Unexpected tokens after the write statement."); }

  #ident(label: string): string {
    const t = this.#next();
    if (t.kind !== "word" || RESERVED_NOT_AN_IDENT.has(t.value.toUpperCase())) throw new Error(`${label} must be a plain identifier; dynamic SQL is outside the governed grammar.`);
    return identifier(t.value, label);
  }
  #literal(): Scalar {
    const t = this.#next();
    if (t.kind === "string") return t.value;
    if (t.kind === "number") return t.value;
    if (t.kind === "word") {
      const upper = t.value.toUpperCase();
      if (upper === "TRUE") return true;
      if (upper === "FALSE") return false;
      if (upper === "NULL") return null;
    }
    throw new Error("Write values must be bound literals; the grammar does not interpolate raw SQL.");
  }

  // Primary expressions: literal | column [source-qualified] | call | CASE | ( expr )
  #primary(inSourceContext: boolean): Expr {
    this.#nodes += 1;
    if (this.#nodes > 200) throw new Error("Write expression exceeds the structural bound.");
    const t = this.#peek();
    if (t === undefined) throw new Error("Write SQL ended unexpectedly.");
    if (t.kind === "string" || t.kind === "number") { this.#pos += 1; return { kind: "literal", value: t.value }; }
    if (t.kind === "param") throw new Error("Placeholders are not accepted in write SQL; inline the literal values (the compiler re-binds them server-side).");
    if (t.kind === "punct" && t.value === "(") { this.#pos += 1; const e = this.#expr(inSourceContext); this.#takePunct(")"); return e; }
    if (t.kind === "word") {
      const upper = t.value.toUpperCase();
      if (upper === "NULL") { this.#pos += 1; return { kind: "literal", value: null }; }
      if (upper === "TRUE" || upper === "FALSE") { this.#pos += 1; return { kind: "literal", value: upper === "TRUE" }; }
      if (upper === "CASE") return this.#caseExpr(inSourceContext);
      if (upper === "SELECT") throw new Error("Subqueries are not part of the governed write grammar; materialize reads through insert_select instead.");
      if (RESERVED_NOT_AN_IDENT.has(upper)) throw new Error(`Unexpected keyword ${upper} in write expression.`);
      // identifier [ . identifier ] [ ( args ) ]
      this.#pos += 1;
      let name = t.value;
      let source = false;
      if (this.#isPunct(".")) {
        this.#pos += 1;
        const second = this.#next();
        if (second.kind !== "word") throw new Error("Expected a column name after the qualifier.");
        if (inSourceContext && name.toUpperCase() === "SRC") { source = true; name = second.value; }
        else throw new Error("Table-qualified column references are outside the governed write grammar; use the source alias SRC in MERGE statements.");
      }
      if (this.#isPunct("(")) {
        this.#pos += 1;
        const args: Expr[] = [];
        if (!this.#isPunct(")")) {
          args.push(this.#expr(inSourceContext));
          while (this.#optionalPunct(",")) args.push(this.#expr(inSourceContext));
        }
        this.#takePunct(")");
        const fn = name.toUpperCase();
        if (!/^[A-Z][A-Z0-9_]*$/.test(fn) || !this.functions.has(fn)) throw new Error(`Function ${fn} is not on the configured write-function allowlist.`);
        if (args.length < 1 || args.length > 4) throw new Error(`Function ${fn} requires 1-4 arguments.`);
        return { kind: "call", fn, args };
      }
      if (source) return { kind: "column", name: identifier(name, "column"), source: true };
      return { kind: "column", name: identifier(name, "column") };
    }
    throw new Error("Unexpected token in write expression.");
  }

  #unary(inSourceContext: boolean): Expr {
    if (this.#isPunct("-")) { this.#pos += 1; const inner = this.#primary(inSourceContext); if (inner.kind !== "literal" || typeof inner.value !== "number") throw new Error("Unary minus applies to numeric literals."); return { kind: "literal", value: -inner.value }; }
    return this.#primary(inSourceContext);
  }

  #arith(inSourceContext: boolean, minLevel = 0): Expr {
    // levels: 0 = ||, 1 = * / %, 2 handled via loop ordering below (simple precedence climb)
    let left = this.#unary(inSourceContext);
    for (;;) {
      const t = this.#peek();
      if (t?.kind === "punct" && t.value === "||") { this.#pos += 1; left = { kind: "binary", op: "||", left, right: this.#unary(inSourceContext) }; continue; }
      if (t?.kind === "punct" && (t.value === "*" || t.value === "/" || t.value === "%")) { this.#pos += 1; left = { kind: "binary", op: t.value as "*" | "/" | "%", left, right: this.#unary(inSourceContext) }; continue; }
      if (minLevel <= 1 && t?.kind === "punct" && (t.value === "+" || t.value === "-")) { this.#pos += 1; left = { kind: "binary", op: t.value as "+" | "-", left, right: this.#arith(inSourceContext, 2) }; continue; }
      return left;
    }
  }

  #expr(inSourceContext: boolean): Expr { return this.#arith(inSourceContext, 0); }

  #caseExpr(inSourceContext: boolean): Expr {
    this.#takeWord("CASE");
    const whens: { when: Pred; result: Expr }[] = [];
    while (this.#isWord("WHEN")) {
      this.#pos += 1;
      const when = this.#pred(inSourceContext, 0);
      this.#takeWord("THEN");
      whens.push({ when, result: this.#expr(inSourceContext) });
      if (whens.length > MAX_CASE_WHENS) throw new Error(`CASE supports at most ${MAX_CASE_WHENS} branches.`);
    }
    if (!whens.length) throw new Error("CASE requires at least one WHEN branch.");
    let elseExpr: Expr | undefined;
    if (this.#optionalWord("ELSE")) elseExpr = this.#expr(inSourceContext);
    this.#takeWord("END");
    return { kind: "case", whens, else: elseExpr };
  }

  #pred(inSourceContext: boolean, depth: number): Pred {
    if (depth > MAX_PRED_DEPTH) throw new Error("Write predicate exceeds the structural depth bound.");
    if (this.#isWord("NOT")) { this.#pos += 1; return { kind: "not", part: this.#pred(inSourceContext, depth + 1) }; }
    const parts = [this.#predAtom(inSourceContext, depth)];
    if (this.#isWord("AND") || this.#isWord("OR")) {
      const op = (this.#peek() as { kind: "word"; value: string }).value.toUpperCase() === "AND" ? "and" : "or";
      while (this.#isWord(op.toUpperCase())) {
        this.#pos += 1;
        parts.push(this.#predAtom(inSourceContext, depth));
        if (parts.length > MAX_GROUP_PARTS) throw new Error(`A ${op.toUpperCase()} group supports at most ${MAX_GROUP_PARTS} parts.`);
      }
      return { kind: op, parts };
    }
    return parts[0];
  }

  #predAtom(inSourceContext: boolean, depth: number): Pred {
    if (this.#isPunct("(")) {
      this.#pos += 1;
      const inner = this.#pred(inSourceContext, depth + 1);
      this.#takePunct(")");
      return inner;
    }
    const left = this.#expr(inSourceContext);
    if (this.#isWord("IS")) {
      this.#pos += 1;
      const negated = this.#optionalWord("NOT");
      this.#takeWord("NULL");
      return { kind: "nullCheck", expr: left, negated };
    }
    if (this.#isWord("IN")) {
      this.#pos += 1;
      this.#takePunct("(");
      const values: Scalar[] = [];
      for (;;) { values.push(this.#literal()); if (!this.#optionalPunct(",")) break; }
      this.#takePunct(")");
      if (values.length < 1 || values.length > MAX_IN_VALUES) throw new Error(`IN supports 1-${MAX_IN_VALUES} bound values.`);
      return { kind: "in", expr: left, values };
    }
    const t = this.#next();
    const ops = ["=", "!=", "<", "<=", ">", ">="] as const;
    if (t.kind !== "punct" || !ops.includes(t.value as (typeof ops)[number])) throw new Error("Expected a comparison in the write predicate.");
    const right = this.#expr(inSourceContext);
    return { kind: "compare", op: t.value as (typeof ops)[number], left, right };
  }

  // --- statements ---------------------------------------------------------------------

  #qualifiedTarget(): string {
    const db = this.#ident("database");
    this.#takePunct(".");
    const schema = this.#ident("schema");
    this.#takePunct(".");
    const table = this.#ident("table");
    return `${db}.${schema}.${table}`;
  }

  #insert(): Mutation {
    this.#takeWord("INSERT");
    this.#takeWord("INTO");
    const target = this.#qualifiedTarget();
    let columns: string[] | undefined;
    if (this.#isPunct("(")) {
      this.#pos += 1;
      columns = [this.#ident("column")];
      while (this.#optionalPunct(",")) columns.push(this.#ident("column"));
      this.#takePunct(")");
      if (columns.length > MAX_COLUMNS) throw new Error(`INSERT supports at most ${MAX_COLUMNS} columns.`);
    }
    if (this.#isWord("VALUES")) {
      this.#pos += 1;
      const rows: Expr[][] = [];
      do {
        this.#takePunct("(");
        const row: Expr[] = [this.#expr(false)];
        while (this.#optionalPunct(",")) row.push(this.#expr(false));
        this.#takePunct(")");
        rows.push(row);
        if (rows.length > MAX_PLAN_ROWS) throw new Error(`INSERT supports at most ${MAX_PLAN_ROWS} rows per statement.`);
      } while (this.#optionalPunct(","));
      if (rows.some((r) => r.length !== rows[0].length)) throw new Error("Every INSERT row must carry one value per column.");
      return { operation: "insert", target, columns: columns ?? rows[0].map((_, i) => `C${i + 1}`), rows, maxRows: DEFAULT_MAX_ROWS };
    }
    if (this.#isWord("SELECT")) {
      // Raw select capture: the governed form materializes it through the read role at execution.
      // The capture stops at the first TOP-LEVEL semicolon so a trailing statement can never be
      // swallowed into the select text — it is parsed (and refused) as its own statement.
      const start = this.#pos;
      let depth = 0;
      while (this.#pos < this.tokens.length) {
        const t = this.tokens[this.#pos];
        if (t.kind === "punct") {
          if (t.value === "(") depth += 1;
          if (t.value === ")") depth -= 1;
          if (t.value === ";" && depth <= 0) break;
        }
        this.#pos += 1;
      }
      const first = this.tokens[start];
      const last = this.tokens[this.#pos - 1];
      const select = this.source.slice(first.start, last.end);
      if (columns === undefined) throw new Error("INSERT ... SELECT requires an explicit column list.");
      return { operation: "insert_select", target, columns, select, maxRows: DEFAULT_MAX_ROWS, maxBytes: 5_000_000 };
    }
    throw new Error("INSERT requires VALUES or SELECT in the governed write grammar.");
  }

  #update(): Mutation {
    this.#takeWord("UPDATE");
    const target = this.#qualifiedTarget();
    this.#takeWord("SET");
    const assignments: { column: string; value: Expr }[] = [];
    do {
      const column = this.#ident("column");
      this.#takePunct("=");
      assignments.push({ column, value: this.#expr(true) });
    } while (this.#optionalPunct(","));
    let where: Pred | undefined;
    if (this.#optionalWord("WHERE")) where = this.#pred(true, 0);
    if (!where) throw new Error("An UPDATE requires a WHERE predicate; empty update predicates are refused.");
    return { operation: "update", target, assignments, where, maxRows: DEFAULT_MAX_ROWS };
  }

  #delete(): Mutation {
    this.#takeWord("DELETE");
    this.#takeWord("FROM");
    const target = this.#qualifiedTarget();
    let where: Pred | undefined;
    if (this.#optionalWord("WHERE")) where = this.#pred(true, 0);
    if (!where) throw new Error("A DELETE requires a WHERE predicate; unconditional deletes are refused.");
    return { operation: "delete", target, where, maxRows: DEFAULT_MAX_ROWS };
  }

  #merge(): Mutation {
    this.#takeWord("MERGE");
    this.#takeWord("INTO");
    const target = this.#qualifiedTarget();
    this.#takeWord("USING");
    this.#takePunct("(");
    this.#takeWord("VALUES");
    const rows: Expr[][] = [];
    do {
      this.#takePunct("(");
      const row: Expr[] = [this.#expr(false)];
      while (this.#optionalPunct(",")) row.push(this.#expr(false));
      this.#takePunct(")");
      rows.push(row);
      if (rows.length > MAX_PLAN_ROWS) throw new Error(`A MERGE source supports at most ${MAX_PLAN_ROWS} rows.`);
    } while (this.#optionalPunct(","));
    this.#takePunct(")");
    // The alias is canonicalized to SRC by the compiler; accept any plain alias name here.
    if (this.#optionalWord("AS")) this.#ident("source alias");
    this.#takePunct("(");
    const columns = [this.#ident("column")];
    while (this.#optionalPunct(",")) columns.push(this.#ident("column"));
    this.#takePunct(")");
    if (rows.some((r) => r.length !== columns.length)) throw new Error("Every MERGE source row must carry one value per source column.");
    this.#takeWord("ON");
    const on = this.#pred(true, 0);
    let matched: { assignments: { column: string; value: Expr }[] } | undefined;
    let notMatched: { columns: string[]; values: Expr[] } | undefined;
    while (this.#isWord("WHEN")) {
      this.#pos += 1;
      if (this.#optionalWord("MATCHED")) {
        if (this.#optionalWord("AND")) this.#pred(true, 1);
        this.#takeWord("THEN");
        this.#takeWord("UPDATE");
        this.#takeWord("SET");
        const assignments: { column: string; value: Expr }[] = [];
        do {
          const column = this.#ident("column");
          this.#takePunct("=");
          assignments.push({ column, value: this.#expr(true) });
        } while (this.#optionalPunct(","));
        matched = { assignments };
      } else {
        this.#takeWord("NOT");
        this.#takeWord("MATCHED");
        if (this.#optionalWord("AND")) this.#pred(true, 1);
        this.#takeWord("THEN");
        this.#takeWord("INSERT");
        this.#takePunct("(");
        const cols = [this.#ident("column")];
        while (this.#optionalPunct(",")) cols.push(this.#ident("column"));
        this.#takePunct(")");
        this.#takeWord("VALUES");
        this.#takePunct("(");
        const values: Expr[] = [this.#expr(true)];
        while (this.#optionalPunct(",")) values.push(this.#expr(true));
        this.#takePunct(")");
        notMatched = { columns: cols, values };
      }
    }
    return { operation: "merge", target, source: { columns, rows }, on, matched, notMatched, maxRows: DEFAULT_MAX_ROWS };
  }

  #statement(): Mutation {
    const t = this.#peek();
    if (t?.kind !== "word") throw new Error("Write SQL must begin with INSERT, UPDATE, DELETE, or MERGE.");
    switch (t.value.toUpperCase()) {
      case "INSERT": return this.#insert();
      case "UPDATE": return this.#update();
      case "DELETE": return this.#delete();
      case "MERGE": return this.#merge();
      default: throw new Error(`Unsupported write statement ${t.value.toUpperCase()}; the governed grammar covers INSERT, UPDATE, DELETE, and MERGE.`);
    }
  }

  /** Parses one statement or a semicolon-separated ordered plan. */
  all(): Mutation[] {
    const mutations: Mutation[] = [this.#statement()];
    while (this.#optionalPunct(";")) {
      if (this.#optionalPunct(";")) throw new Error("Empty statements are not allowed in a write plan.");
      if (mutations.length >= MAX_PLAN_STEPS) throw new Error(`A write plan supports at most ${MAX_PLAN_STEPS} statements.`);
      mutations.push(this.#statement());
    }
    this.#end();
    return mutations;
  }
}

/**
 * Parses write SQL into the governed plan. Multiple statements (semicolon-separated) become one
 * ordered plan. A `?` placeholder is a refusal: values must be inline literals, which the
 * compiler re-binds server-side. Everything the grammar cannot certify is refused with a
 * message naming the gap.
 */
export function parseWriteSql(sql: string, functions: Set<string>): WritePlan {
  if (typeof sql !== "string" || !sql.trim()) throw new Error("Write SQL is required.");
  if (/\?/.test(sql)) throw new Error("Placeholders are not accepted in write SQL; inline the literal values (the compiler re-binds them server-side).");
  const tokens = tokenize(sql);
  const mutations = new Parser(sql, tokens, functions).all();
  return mutations.length === 1 ? mutations[0] : { operation: "plan", steps: mutations.map((mutation) => ({ mutation })) };
}
