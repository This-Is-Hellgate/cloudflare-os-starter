import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { catalogDrift, parseCatalogEntries } from "./boundary-check.ts";

/**
 * Re-sync this repository's `pnpm-workspace.yaml` catalog entries with the vendored kernel's.
 *
 * The kernel's catalog is the source of truth: two of its packages are members of this workspace
 * and resolve `catalog:` specifiers here, so a stale entry silently gives the tree two copies of
 * `capnweb` (see the workspace file's comment and scripts/boundary-check.ts). The upstream sync
 * workflow runs this after every subtree pull so drift never needs a human in the loop.
 *
 * Existing shared keys are updated in place (the kernel's raw value text is used verbatim);
 * shared keys missing here are added right after the last existing catalog entry. Outer-only
 * keys are left alone. Returns one human-readable line per change; empty means already in sync.
 */
export function resyncCatalog(outerPath: string, kernelPath: string): string[] {
  const outerText = readFileSync(outerPath, "utf8");
  const kernelEntries = parseCatalogEntries(readFileSync(kernelPath, "utf8"));
  const outerEntries = parseCatalogEntries(outerText);
  const drift = catalogDrift(outerEntries, kernelEntries);
  if (!drift.length) return [];

  const lines = outerText.split("\n");
  const changes: string[] = [];
  const edits: { at: number; text: string | null }[] = []; // null = delete line
  let inCatalog = false;
  let lastCatalogLine = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^catalog:\s*(#.*)?$/.test(line)) {
      inCatalog = true;
      continue;
    }
    if (!inCatalog) continue;
    if (!/^\s/.test(line)) {
      inCatalog = false;
      continue;
    }
    if (/^\s*#/.test(line)) continue; // comment lines may contain colons
    const match = line.match(/^(\s+)(["']?)([^":]+)\2:(\s*)(.+?)\s*(#.*)?$/);
    if (!match) continue;
    const [, indent, quote, key, , , comment] = match;
    const newValue = kernelEntries.get(key);
    if (newValue === undefined) continue;
    const oldValue = outerEntries.get(key);
    if (oldValue === newValue) continue;
    lines[i] = `${indent}${quote}${key}${quote}: ${newValue}${comment ? ` ${comment}` : ""}`;
    changes.push(`${key}: ${oldValue ?? "(missing)"} -> ${newValue}`);
    lastCatalogLine = i;
  }

  // Keys entirely missing from the outer catalog: append after the last catalog entry.
  for (const [key, value] of kernelEntries) {
    if (!outerEntries.has(key)) {
      const quote = key.includes(".") || /[A-Z]/.test(key[0]) ? `"${key}"` : key;
      edits.push({ at: lastCatalogLine, text: `  ${quote}: ${value}` });
      changes.push(`${key}: added (${value})`);
    }
  }

  // Apply appends bottom-up so earlier indices stay valid.
  for (const edit of edits.toReversed()) {
    if (edit.text !== null) lines.splice(edit.at + 1, 0, edit.text);
  }

  writeFileSync(outerPath, lines.join("\n"));
  return changes;
}

const root = resolve(import.meta.dirname, "..");
if (import.meta.main) {
  const changes = resyncCatalog(join(root, "pnpm-workspace.yaml"), join(root, "cloudflare-os/pnpm-workspace.yaml"));
  if (changes.length) {
    console.log("Catalog re-synced with the kernel:");
    for (const change of changes) console.log(`- ${change}`);
    process.exitCode = 1;
  } else {
    console.log("Catalog already in sync with the kernel.");
  }
}
