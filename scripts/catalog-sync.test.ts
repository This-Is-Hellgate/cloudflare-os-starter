import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { resyncCatalog } from "./catalog-sync.ts";

const OUTER = [
  "packages:",
  "  - packages/*",
  "catalog:",
  "  capnweb: ^0.12.0",
  "  # Exact: pinned in lockstep with capnweb (declared as a >=0.7.0 peer)",
  "  capnweb-validate: 0.3.0",
  "  vitest: ^4.1.10 # a trailing comment survives",
  "  wrangler: ^4.128.0",
].join("\n");
const KERNEL = [
  "packages:",
  "  - packages/*",
  "catalog:",
  "  capnweb: ^0.12.0",
  "  capnweb-validate: 0.3.0",
  "  typescript: 7.0.2",
  "  vitest: ^4.1.11",
  "  wrangler: ^4.128.0",
].join("\n");

test("resyncCatalog updates stale values, keeps comments, and adds missing keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "catalog-sync-"));
  try {
    const outerPath = join(dir, "pnpm-workspace.yaml");
    const kernelPath = join(dir, "kernel-pnpm-workspace.yaml");
    writeFileSync(outerPath, OUTER + "\n");
    writeFileSync(kernelPath, KERNEL + "\n");

    const changes = resyncCatalog(outerPath, kernelPath);
    assert.equal(changes.length, 2, `expected vitest update + new key, got: ${changes.join(" | ")}`);

    const result = readFileSync(outerPath, "utf8");
    assert.match(result, /capnweb-validate: 0\.3\.0\n/);
    assert.match(result, /vitest: \^4\.1\.11 # a trailing comment survives/);
    assert.ok(result.includes("  typescript: 7.0.2\n"), "missing shared key is added");
    // Idempotent: a second run is a no-op.
    assert.deepEqual(resyncCatalog(outerPath, kernelPath), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
