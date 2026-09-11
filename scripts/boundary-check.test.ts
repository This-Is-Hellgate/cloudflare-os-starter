import { test } from "node:test";
import assert from "node:assert/strict";
import { collectBoundaryIssues } from "./boundary-check.ts";

test("outer Starter and nested cloudflare-os repositories have no drift", () => {
  assert.deepEqual(collectBoundaryIssues(), []);
});
