import { describe, expect, it } from "vitest";
import { allowed, identifier, qualified, snowflakePolicy, validateWriteProposal, writesEnabled } from "../src/policy.js";

const env = (over: Partial<Env> = {}): Env => ({ SNOWFLAKE_TOKEN: "t", SNOWFLAKE_ACCOUNT: "acct", SNOWFLAKE_ROLE: "ROLE", ...over } as Env);

describe("snowflakePolicy", () => {
  it("requires credentials", () => {
    expect(() => snowflakePolicy({ SNOWFLAKE_ACCOUNT: "a", SNOWFLAKE_ROLE: "r" } as Env)).toThrow("Snowflake credentials are not configured.");
  });

  it("uppercases and trims allowlist entries", () => {
    const p = snowflakePolicy(env({ SNOWFLAKE_DATABASES: " analytics , Sales ", SNOWFLAKE_TABLES: "db.s.t" }));
    expect([...p.databases]).toEqual(["ANALYTICS", "SALES"]);
    expect([...p.tables]).toEqual(["DB.S.T"]);
    expect(p.semanticViews.size).toBe(0);
  });

  it("clamps operator limits to hard caps and falls back on garbage", () => {
    expect(snowflakePolicy(env({ SNOWFLAKE_MAX_ROWS: "999999" })).maxRows).toBe(10_000);
    expect(snowflakePolicy(env({ SNOWFLAKE_MAX_BYTES: "-5" })).maxBytes).toBe(2_000_000);
    expect(snowflakePolicy(env({ SNOWFLAKE_MAX_ROWS: "50" })).maxRows).toBe(50);
  });
});

describe("writesEnabled", () => {
  it("is fail-closed", () => {
    expect(writesEnabled(env())).toBe(false);
    expect(writesEnabled(env({ SNOWFLAKE_ENABLE_WRITES: "yes" }))).toBe(false);
    expect(writesEnabled(env({ SNOWFLAKE_ENABLE_WRITES: "true" }))).toBe(true);
    expect(writesEnabled(env({ SNOWFLAKE_ENABLE_WRITES: "1" }))).toBe(true);
  });
});

describe("identifier", () => {
  it("accepts legal identifiers and uppercases them", () => {
    expect(identifier("analytics", "database")).toBe("ANALYTICS");
    expect(identifier("T_1$x", "table")).toBe("T_1$X");
  });

  it("rejects injection and quoting attempts", () => {
    for (const bad of ["A.B", 'A"B', "A B", "", "1A", "A;B", "A--B", "A/*B"]) expect(() => identifier(bad, "database")).toThrow("Invalid database.");
  });
});

describe("qualified", () => {
  it("builds fully-qualified names", () => {
    expect(qualified("db", "sch", "tbl")).toBe("DB.SCH.TBL");
    expect(qualified("db", "sch")).toBe("DB.SCH");
  });
});

describe("allowed", () => {
  it("permits everything when the allowlist is empty", () => {
    expect(() => allowed(new Set(), "ANY.THING", "Table")).not.toThrow();
  });

  it("matches qualified entries only by full name", () => {
    const set = new Set(["DB.S.T"]);
    expect(() => allowed(set, "DB.S.T", "Table")).not.toThrow();
    expect(() => allowed(set, "db.s.t", "Table")).not.toThrow();
    expect(() => allowed(set, "T", "Table")).toThrow("Table is outside the configured allowlist.");
    expect(() => allowed(set, "OTHER.S.T", "Table")).toThrow("Table is outside the configured allowlist.");
    expect(() => allowed(set, "OTHER", "Table")).toThrow("Table is outside the configured allowlist.");
  });

  it("matches bare entries by last segment", () => {
    const set = new Set(["T"]);
    expect(() => allowed(set, "DB.S.T", "Table")).not.toThrow();
    expect(() => allowed(set, "OTHER", "Table")).toThrow("Table is outside the configured allowlist.");
  });
});

describe("validateWriteProposal", () => {
  const policy = snowflakePolicy(env({ SNOWFLAKE_TABLES: "ANALYTICS.PUBLIC.EVENTS" }));
  const unrestricted = snowflakePolicy(env());

  it("accepts a bounded operation against an allowlisted target", () => {
    const r = validateWriteProposal(policy, "insert", "analytics.public.events", "INSERT INTO ANALYTICS.PUBLIC.EVENTS (id) VALUES (1)");
    expect(r).toEqual({ table: "ANALYTICS.PUBLIC.EVENTS", database: "ANALYTICS", schema: "PUBLIC" });
  });

  it("rejects non-DML operations and unqualified targets", () => {
    expect(() => validateWriteProposal(policy, "delete", "A.B.C", "DELETE FROM A.B.C")).toThrow("Only bounded INSERT, UPDATE, or MERGE proposals are permitted.");
    expect(() => validateWriteProposal(policy, "insert", "A.B", "INSERT INTO A.B VALUES (1)")).toThrow("Write target must be DATABASE.SCHEMA.TABLE.");
    expect(() => validateWriteProposal(policy, "insert", "OTHER.S.T", "INSERT INTO OTHER.S.T VALUES (1)")).toThrow("Table is outside the configured allowlist.");
  });

  it("rejects operation-prefix mismatches and destructive keywords", () => {
    expect(() => validateWriteProposal(unrestricted, "update", "A.S.T", "INSERT INTO A.S.T VALUES (1)")).toThrow("Only bounded INSERT, UPDATE, or MERGE proposals are permitted.");
    expect(() => validateWriteProposal(unrestricted, "insert", "A.S.T", "INSERT INTO A.S.T VALUES (1); DROP TABLE X")).toThrow("Only bounded INSERT, UPDATE, or MERGE proposals are permitted.");
    expect(() => validateWriteProposal(unrestricted, "merge", "A.S.T", "MERGE INTO A.S.T USING (SELECT 1) S ON TRUE WHEN MATCHED THEN DELETE")).toThrow("Only bounded INSERT, UPDATE, or MERGE proposals are permitted.");
  });

  it("bounds the SQL size", () => {
    expect(() => validateWriteProposal(unrestricted, "insert", "A.S.T", `INSERT INTO A.S.T VALUES ('${"x".repeat(33_000)}')`)).toThrow("SQL proposal exceeds the size limit.");
  });
});
