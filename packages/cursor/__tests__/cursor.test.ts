import { describe, expect, it, vi } from "vitest";
import { LivePageSource, offsetPaged } from "../src/cursor.js";

describe("LivePageSource", () => {
  it("delivers pages in sequence, one vendor fetch per next()", async () => {
    const fetchPage = vi.fn()
      .mockResolvedValueOnce({ items: [1, 2], exhausted: false })
      .mockResolvedValueOnce({ items: [3], exhausted: true });
    const source = new LivePageSource<number>({ fetchPage, label: "test" });
    expect(await source.next()).toEqual([1, 2]);
    expect(await source.next()).toEqual([3]);
    expect(await source.next()).toBeNull();
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(source.walked).toBe(2);
  });

  it("is idempotently exhausted: null repeats without further vendor calls", async () => {
    const fetchPage = vi.fn().mockResolvedValue({ items: [], exhausted: true });
    const source = new LivePageSource<number>({ fetchPage });
    expect(await source.next()).toEqual([]);
    expect(await source.next()).toBeNull();
    expect(await source.next()).toBeNull();
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("enforces the walk budget with a refusal, not silent truncation", async () => {
    const fetchPage = vi.fn().mockResolvedValue({ items: ["x"], exhausted: false });
    const source = new LivePageSource<string>({ fetchPage, maxPages: 2 });
    await source.next();
    await source.next();
    await expect(source.next()).rejects.toThrow(/2-page limit/);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("rejects out-of-range page budgets at construction", () => {
    const noop = async () => ({ items: [], exhausted: true });
    expect(() => new LivePageSource({ fetchPage: noop, maxPages: 0 })).toThrow(/between 1 and 100/);
    expect(() => new LivePageSource({ fetchPage: noop, maxPages: 101 })).toThrow(/between 1 and 100/);
    expect(() => new LivePageSource({ fetchPage: noop, maxPages: 1.5 })).toThrow(/between 1 and 100/);
  });

  it("close() ends the capability lifetime; closed cursors refuse walks", async () => {
    const fetchPage = vi.fn().mockResolvedValue({ items: [1], exhausted: false });
    const source = new LivePageSource<number>({ fetchPage });
    source.close();
    source.close(); // idempotent
    await expect(source.next()).rejects.toThrow(/closed/);
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("rejects overlapping walks without consuming budget", async () => {
    let release!: (value: { items: number[]; exhausted: boolean }) => void;
    const gate = new Promise<{ items: number[]; exhausted: boolean }>((resolve) => { release = resolve; });
    const fetchPage = vi.fn().mockReturnValue(gate);
    const source = new LivePageSource<number>({ fetchPage });
    const first = source.next();
    await expect(source.next()).rejects.toThrow(/in progress/);
    release({ items: [1], exhausted: true });
    expect(await first).toEqual([1]);
    // The rejected overlap did not advance the walk; the budget is intact.
    expect(source.walked).toBe(1);
  });

  it("keeps the cursor usable after a failed fetch, and counts the attempt", async () => {
    const fetchPage = vi.fn()
      .mockRejectedValueOnce(new Error("Hugging Face request failed (503)."))
      .mockResolvedValueOnce({ items: [1], exhausted: false });
    const source = new LivePageSource<number>({ fetchPage, maxPages: 2 });
    await expect(source.next()).rejects.toThrow(/503/);
    expect(await source.next()).toEqual([1]);
    expect(source.walked).toBe(2);
    // The budget bounds attempts, so one walk remains — a third call is refused.
    await expect(source.next()).rejects.toThrow(/2-page limit/);
  });

  it("returns an empty page once, then null — never skipping reported data", async () => {
    // A filtered walk can legitimately produce an empty page mid-walk; exhaustion comes only
    // from the vendor's own exhausted signal.
    const fetchPage = vi.fn()
      .mockResolvedValueOnce({ items: [], exhausted: false })
      .mockResolvedValueOnce({ items: [7], exhausted: false })
      .mockResolvedValueOnce({ items: [], exhausted: true });
    const source = new LivePageSource<number>({ fetchPage, maxPages: 3 });
    expect(await source.next()).toEqual([]);
    expect(await source.next()).toEqual([7]);
    expect(await source.next()).toEqual([]);
    expect(await source.next()).toBeNull();
  });
});

describe("offsetPaged", () => {
  it("derives exhaustion from the vendor's reported total, not from page fullness", async () => {
    // Contract verified against the live Hub endpoint: fixed-size pages, p-numbered offsets, and
    // a total count on every response. A full final page must still end the walk.
    const pages = new Map<number, string[]>([
      [0, ["a", "b"]],
      [1, ["c", "d"]], // full page, but the total says this is everything
    ]);
    const fetchPage = vi.fn(async (page: number) => ({ items: pages.get(page) ?? [], total: 4 }));
    const source = offsetPaged<string>({ fetchPage, pageSize: 2, label: "discussions" });
    expect(await source.next()).toEqual(["a", "b"]);
    expect(await source.next()).toEqual(["c", "d"]);
    expect(await source.next()).toBeNull();
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("ends the walk on a full final page once the reported total is delivered", async () => {
    // Verified Hub contract: pages are dense in matching items, `count` is the filtered total.
    const pages = ["a", "b", "c"];
    const fetchPage = vi.fn(async (page: number) => ({
      items: pages.slice(page * 2, page * 2 + 2),
      total: pages.length,
    }));
    const source = offsetPaged<string>({ fetchPage, pageSize: 2, label: "discussions" });
    expect(await source.next()).toEqual(["a", "b"]);
    expect(await source.next()).toEqual(["c"]);
    expect(await source.next()).toBeNull();
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });
});
