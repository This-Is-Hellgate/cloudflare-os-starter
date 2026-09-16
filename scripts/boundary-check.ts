import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const KERNEL_PATH = "cloudflare-os";
export const OFFICIAL_UPSTREAM = "https://github.com/cloudflare/cloudflare-os.git";
const PIN_FILE = "scripts/upstream-pin.json";

function git(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * Parse a pnpm-workspace.yaml top-level `catalog:` block into entries.
 *
 * Both this repository's and the kernel's catalog blocks are flat `key: value` lines, so a
 * line-oriented parse is exact for the files we check and avoids a YAML dependency. Keys may be
 * bare or quoted; values are kept verbatim (including any quoting) so a byte-identical
 * comparison matches the documented invariant ("keep every shared entry byte-identical").
 */
export function parseCatalogEntries(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  let inCatalog = false;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (/^catalog:\s*(#.*)?$/.test(line)) {
      inCatalog = true;
      continue;
    }
    if (!inCatalog) continue;
    if (/^\s/.test(line)) {
      if (/^\s*#/.test(line)) continue; // comment lines may contain colons
      const match = line.match(/^\s+(["']?)([^":]+)\1:\s*(.+?)\s*(#.*)?$/);
      if (match) entries.set(match[2], match[3]);
      continue;
    }
    inCatalog = false;
  }
  return entries;
}

/** Keys whose values differ between the outer and kernel catalogs, and keys missing here. */
export function catalogDrift(outer: Map<string, string>, kernel: Map<string, string>): string[] {
  const drift: string[] = [];
  for (const [key, outerValue] of outer) {
    const kernelValue = kernel.get(key);
    if (kernelValue === undefined) {
      drift.push(`${key}: kernel catalog has no entry for this shared key`);
    } else if (kernelValue !== outerValue) {
      drift.push(`${key}: outer "${outerValue}" != kernel "${kernelValue}"`);
    }
  }
  return drift;
}

function readPin(root: string): { repo: string; commit: string; syncedAt?: string } | null {
  const path = join(root, PIN_FILE);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Return all violations of the single-repository / vendored-upstream boundary. */
export function collectBoundaryIssues(root = resolve(import.meta.dirname, "..")): string[] {
  const issues: string[] = [];
  const kernel = join(root, KERNEL_PATH);

  // The submodule era is over: no .gitmodules may come back, and the kernel must be a regular
  // tracked tree, not a gitlink.
  if (existsSync(join(root, ".gitmodules"))) {
    issues.push(".gitmodules exists; the upstream kernel is vendored as a regular directory");
  }
  try {
    const mode = git(root, ["ls-tree", "HEAD", "--", KERNEL_PATH]).split(/\s+/)[0] ?? "";
    if (!mode.startsWith("040")) {
      issues.push(`cloudflare-os is not tracked as a regular directory in HEAD (mode ${mode || "?"})`);
    }
  } catch (error) {
    issues.push(`cannot read HEAD tree: ${(error as Error).message}`);
  }
  if (!existsSync(join(kernel, "package.json"))) {
    issues.push("cloudflare-os/package.json is missing; the vendored kernel is incomplete");
  }

  // Provenance: the pin file records which upstream commit the vendored tree must equal.
  const pin = readPin(root);
  if (!pin) {
    issues.push(`${PIN_FILE} is missing or unparseable`);
  } else {
    if (pin.repo?.replace(/\/$/, "") !== OFFICIAL_UPSTREAM.replace(/\/$/, "")) {
      issues.push(`upstream pin repo is not the official upstream (${pin.repo ?? "missing"})`);
    }
    if (!/^[0-9a-f]{40}$/.test(pin.commit ?? "")) {
      issues.push("upstream pin commit is not a full 40-hex SHA");
    } else {
      try {
        if (!existsSync(join(kernel, "package.json"))) {
          // already reported above
        } else {
          const pinTree = git(root, ["rev-parse", `${pin.commit}^{tree}`]);
          const vendoredTree = git(root, ["rev-parse", `HEAD:${KERNEL_PATH}`]);
          if (pinTree !== vendoredTree) {
            issues.push(
              `vendored cloudflare-os tree ${vendoredTree} differs from pinned upstream ${pin.commit} tree ${pinTree}`,
            );
          }
        }
      } catch {
        // The pinned commit object is not local (fresh shallow clone, offline). Fetch it once;
        // if that is impossible we still verify every structural invariant above.
        try {
          git(root, ["fetch", OFFICIAL_UPSTREAM, pin.commit, "--quiet"]);
          const pinTree = git(root, ["rev-parse", `${pin.commit}^{tree}`]);
          const vendoredTree = git(root, ["rev-parse", `HEAD:${KERNEL_PATH}`]);
          if (pinTree !== vendoredTree) {
            issues.push(
              `vendored cloudflare-os tree ${vendoredTree} differs from pinned upstream ${pin.commit} tree ${pinTree}`,
            );
          }
        } catch (error) {
          issues.push(
            `cannot verify the vendored tree against the pinned upstream commit (fetch failed: ${(error as Error).message.split("\n")[0]})`,
          );
        }
      }
    }
  }

  // Generated Wrangler files must never become tracked configuration.
  try {
    const tracked = git(root, ["ls-files", "-z"])
      .split("\0")
      .filter(Boolean)
      .filter((file) => file.includes("/.wrangler/") || file.endsWith("/.wrangler") || file.endsWith("wrangler.prod.jsonc"));
    if (tracked.length) {
      issues.push(`generated Wrangler files are tracked: ${tracked.join(", ")}`);
    }
  } catch (error) {
    issues.push(`cannot inspect tracked files: ${(error as Error).message}`);
  }

  // Catalog drift: the two workspace packages borrowed from the kernel resolve `catalog:`
  // specifiers here, so a stale outer catalog entry silently duplicates capnweb across the two
  // installs (see the workspace file's comment). The kernel's own catalog is the source of truth.
  try {
    const outerCatalog = parseCatalogEntries(readFileSync(join(root, "pnpm-workspace.yaml"), "utf8"));
    const kernelCatalog = parseCatalogEntries(readFileSync(join(kernel, "pnpm-workspace.yaml"), "utf8"));
    issues.push(...catalogDrift(outerCatalog, kernelCatalog).map((entry) => `catalog drift: ${entry}`));
  } catch (error) {
    issues.push(`cannot compare workspace catalogs: ${(error as Error).message}`);
  }

  return issues;
}

if (import.meta.main) {
  const issues = collectBoundaryIssues();
  if (issues.length) {
    console.error("Repository boundary check failed:");
    for (const issue of issues) console.error(`- ${issue}`);
    process.exitCode = 1;
  } else {
    console.log("Repository boundary check passed: vendored kernel matches the pinned upstream commit.");
  }
}
