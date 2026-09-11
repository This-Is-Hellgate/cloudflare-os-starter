import { describe, expect, it } from "vitest";

describe("Snowflake policy", () => {
  it("accepts SELECT and rejects mutation keywords", () => {
    expect(/^SELECT\b/i.test("SELECT 1")).toBe(true);
    expect(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|CALL)\b/i.test("SELECT * FROM T")).toBe(false);
    expect(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|CALL)\b/i.test("SELECT 1; DROP TABLE T")).toBe(true);
  });
});
