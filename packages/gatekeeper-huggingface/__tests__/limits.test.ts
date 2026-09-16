// Task 1.4 focused verification: one Unicode output-boundary regression per distinct
// implementation path. The declared ceilings are UTF-8 bytes; these fixtures prove they hold
// when characters cost 2-4 bytes each (emoji, CJK) — the exact case the old UTF-16-unit
// accounting silently overstated.
import { describe, expect, it } from "vitest";
import { capOutput, fitRowsToByteBudget, streamTextCapped, utf8Bytes } from "../src/limits.js";

// "héllo🎉🎉🎉…": each emoji is 1 UTF-16 unit but 4 UTF-8 bytes.
function unicodeBlob(chars: number): string {
  return "héllo" + "🎉".repeat(chars);
}

describe("UTF-8 output boundaries", () => {
  it("capOutput holds the byte ceiling for multi-byte content", () => {
    const ceiling = 200;
    const oversized = { text: unicodeBlob(500) };
    expect(utf8Bytes(JSON.stringify(oversized))).toBeGreaterThan(ceiling);
    const capped = capOutput(oversized, ceiling);
    expect(capped.truncated).toBe(true);
    // The delivered output encodes to at most the declared ceiling (+ the one ellipsis marker).
    expect(utf8Bytes(capped.output as string)).toBeLessThanOrEqual(ceiling);
    // Whole characters survive: the truncated text decodes back without replacement garbage.
    expect((capped.output as string).startsWith("{\"text\":\"héllo🎉")).toBe(true);
  });

  it("capOutput passes small ASCII payloads through unmodified", () => {
    const value = { a: 1 };
    const capped = capOutput(value, 1000);
    expect(capped).toEqual({ output: value, truncated: false });
  });

  it("fitRowsToByteBudget keeps whole rows within the cumulative byte budget", () => {
    const rows = [
      ["ascii"],
      ["héllo🎉🎉"], // heavy: 4-byte emoji per unit
      ["more", "content", "here🎉🎉🎉🎉"],
      ["trailing"],
    ];
    const budget = utf8Bytes(JSON.stringify([rows[0], rows[1]])) + 1;
    const fitted = fitRowsToByteBudget(rows, budget);
    expect(fitted.kept).toEqual([rows[0], rows[1]]);
    expect(fitted.truncated).toBe(true);
    expect(utf8Bytes(JSON.stringify(fitted.kept))).toBeLessThanOrEqual(budget);
  });

  it("fitRowsToByteBudget always delivers at least one row", () => {
    const huge = [["🎉".repeat(100)]];
    // Nothing was dropped with a single row, so this is not a truncation.
    expect(fitRowsToByteBudget(huge, 10)).toEqual({ kept: huge, truncated: false });
    // A following row is dropped; the oversized first row still delivers alone.
    const fitted = fitRowsToByteBudget([huge[0], ["x"]], 10);
    expect(fitted.kept).toEqual(huge);
    expect(fitted.truncated).toBe(true);
  });

  it("streamTextCapped stops reading past the ceiling and never buffers the whole body", async () => {
    let pulled = 0;
    const heavy = "🎉".repeat(200); // 800 bytes of UTF-8, 400 UTF-16 units
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        const chunk = new TextEncoder().encode(heavy);
        controller.enqueue(chunk);
        // Far more content available than any cap: only the cap may stop the pull.
        if (pulled > 100) controller.close();
      },
    });
    const response = new Response(stream);
    const text = await streamTextCapped(response, 300);
    // The delivered string encodes to at most the declared ceiling.
    expect(utf8Bytes(text)).toBeLessThanOrEqual(300);
    // Reading stopped early: not every produced chunk was buffered.
    expect(pulled).toBeLessThan(10);
  });

  it("streamTextCapped handles a complete small body and torn multi-byte tails", async () => {
    const body = "héllo🎉".repeat(10);
    const response = new Response(new TextEncoder().encode(body));
    expect(await streamTextCapped(response, 10_000)).toBe(body);
    // A ceiling that lands mid-emoji strips the torn tail instead of decoding replacement garbage.
    const torn = await streamTextCapped(new Response(new TextEncoder().encode(body)), utf8Bytes("héllo🎉".repeat(5)) + 2);
    expect(torn).toBe("héllo🎉".repeat(5) + "h");
  });
});
