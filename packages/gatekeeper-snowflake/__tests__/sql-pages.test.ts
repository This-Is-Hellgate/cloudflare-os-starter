import { describe, expect, it, vi } from "vitest";
import { boundedSelect, partitionPager } from "../src/sql-pages.js";

describe("boundedSelect", () => {
  it("accepts and normalizes bounded SELECT statements", () => {
    expect(boundedSelect("  select 1;;;")).toBe("select 1");
    expect(boundedSelect("SELECT * FROM t")).toBe("SELECT * FROM t");
  });

  it("rejects writes, DDL, session mutation, and oversized statements", () => {
    for (const bad of [
      "INSERT INTO t VALUES (1)",
      "UPDATE t SET x = 1",
      "DELETE FROM t",
      "CREATE TABLE t (x int)",
      "DROP TABLE t",
      "TRUNCATE TABLE t",
      "CALL do_thing()",
      "USE ROLE admin",
      "GRANT SELECT ON t TO r",
      "PUT file://x @stage",
      "select 1; DROP TABLE t",
    ]) {
      expect(() => boundedSelect(bad)).toThrow(/Only bounded SELECT/);
    }
    expect(() => boundedSelect(`SELECT ${"x".repeat(33_000)}`)).toThrow(/Only bounded SELECT/);
  });
});

describe("partitionPager", () => {
  const opts = { rowsPerPage: 2, maxRows: 100, maxBytes: 10_000_000 };

  it("walks partitions promised by the verified metadata, in order", async () => {
    const fetchPartition = vi.fn(async (n: number) => ({ rows: [[`p${n}-a`], [`p${n}-b`]] }));
    const pager = partitionPager(
      { rows: [["p0-a"]], totalRows: 5, partitions: [{ rowCount: 1 }, { rowCount: 2 }, { rowCount: 2 }] },
      opts,
      fetchPartition,
    );
    expect(pager.totalRows).toBe(5);
    expect(pager.partitions).toHaveLength(3);

    const first = await pager.fetchPage();
    expect(first.items[0]).toMatchObject({ rows: [["p0-a"], ["p1-a"]], rowCount: 2, partitionsFetched: 2 });
    expect(first.exhausted).toBe(false);

    const second = await pager.fetchPage();
    expect(second.items[0]).toMatchObject({ rows: [["p1-b"], ["p2-a"]], deliveredRows: 4 });

    const third = await pager.fetchPage();
    expect(third.items[0]).toMatchObject({ rows: [["p2-b"]], deliveredRows: 5 });
    expect(third.exhausted).toBe(true); // the verified total has been delivered

    expect(await pager.fetchPage()).toEqual({ items: [], exhausted: true });
    // No fetch beyond the promised partitions.
    expect(fetchPartition).toHaveBeenCalledTimes(2);
  });

  it("never fetches a partition when the first response holds everything", async () => {
    const fetchPartition = vi.fn();
    const pager = partitionPager(
      { rows: [["a"], ["b"]], totalRows: 2, partitions: [{ rowCount: 2 }] },
      opts,
      fetchPartition,
    );
    const page = await pager.fetchPage();
    expect(page.items[0]).toMatchObject({ rows: [["a"], ["b"]], deliveredRows: 2 });
    expect(page.exhausted).toBe(true);
    expect(fetchPartition).not.toHaveBeenCalled();
  });

  it("slices large partitions into rowsPerPage pages without refetching", async () => {
    const bigPartition = Array.from({ length: 5 }, (_, i) => [`row${i}`]);
    const fetchPartition = vi.fn();
    const pager = partitionPager(
      { rows: bigPartition, partitions: [{ rowCount: 5 }] },
      { rowsPerPage: 2, maxRows: 100, maxBytes: 10_000_000 },
      fetchPartition,
    );
    expect((await pager.fetchPage()).items[0]?.rows).toEqual([["row0"], ["row1"]]);
    expect((await pager.fetchPage()).items[0]?.rows).toEqual([["row2"], ["row3"]]);
    const last = await pager.fetchPage();
    expect(last.items[0]?.rows).toEqual([["row4"]]);
    expect(last.exhausted).toBe(true);
    expect(fetchPartition).not.toHaveBeenCalled();
  });

  it("enforces the cumulative row budget across the walk", async () => {
    const fetchPartition = vi.fn(async () => ({ rows: [["x"], ["x"], ["x"]] }));
    const pager = partitionPager(
      { rows: [["x"], ["x"]], partitions: [{ rowCount: 2 }, { rowCount: 3 }] },
      { rowsPerPage: 2, maxRows: 4, maxBytes: 10_000_000 },
      fetchPartition,
    );
    await pager.fetchPage(); // 2
    const second = await pager.fetchPage(); // would deliver 3, budget stops at 2 more
    expect(second.items[0]?.deliveredRows).toBe(4);
    expect(second.exhausted).toBe(true);
  });

  it("enforces the cumulative byte budget with whole-row drops and honest truncation", async () => {
    const fetchPartition = vi.fn();
    const pager = partitionPager(
      { rows: [["x".repeat(60)], ["y".repeat(60)]], partitions: [{ rowCount: 2 }] },
      { rowsPerPage: 2, maxRows: 100, maxBytes: 100 },
      fetchPartition,
    );
    const page = await pager.fetchPage();
    // One row fits inside 100 bytes; the second is dropped whole, and the page reports it. Every
    // received row is now delivered or dropped, and no further partitions are promised: the walk
    // ends honestly rather than promising data the budget will never deliver.
    expect(page.items[0]?.rowCount).toBe(1);
    expect(page.items[0]?.truncated).toBe(true);
    expect(page.exhausted).toBe(true);
    expect(await pager.fetchPage()).toEqual({ items: [], exhausted: true });
    expect(fetchPartition).not.toHaveBeenCalled();
  });

  it("treats a response without partition metadata as a single-partition result", async () => {
    const fetchPartition = vi.fn();
    const pager = partitionPager({ rows: [["a"]] }, opts, fetchPartition);
    const page = await pager.fetchPage();
    expect(page.items[0]?.rows).toEqual([["a"]]);
    expect(page.exhausted).toBe(true);
    expect(fetchPartition).not.toHaveBeenCalled();
  });
});
