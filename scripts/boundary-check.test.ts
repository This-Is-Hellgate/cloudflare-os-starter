import { test } from "node:test";
import assert from "node:assert/strict";
import { catalogDrift, collectBoundaryIssues, parseCatalogEntries } from "./boundary-check.ts";

test("the single repository matches the pinned upstream and catalog rules", () => {
  assert.deepEqual(collectBoundaryIssues(), []);
});

test("parseCatalogEntries reads the flat catalog block", () => {
  const text = [
    "packages:",
    "  - packages/*",
    "catalog:",
    "  capnweb: ^0.12.0",
    "  # comment line",
    "  'typescript': 7.0.2",
    "overrides:",
    "  vite: \"catalog:\"",
  ].join("\n");
  const entries = parseCatalogEntries(text);
  assert.equal(entries.size, 2);
  assert.equal(entries.get("capnweb"), "^0.12.0");
  assert.equal(entries.get("typescript"), "7.0.2");
});

test("catalogDrift names stale and missing shared entries", () => {
  const outer = new Map([
    ["capnweb", "^0.12.0"],
    ["vite", "7.3.6"],
  ]);
  const kernel = new Map([
    ["capnweb", "^0.13.0"],
  ]);
  const drift = catalogDrift(outer, kernel);
  assert.equal(drift.length, 2);
  assert.ok(drift[0].startsWith("capnweb:"));
  assert.ok(drift[1].startsWith("vite:"));
});
