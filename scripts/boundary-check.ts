import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const SUBMODULE_PATH = "cloudflare-os";
const OFFICIAL_UPSTREAM = "https://github.com/cloudflare/cloudflare-os.git";

function git(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Return all violations of the Starter/upstream repository boundary. */
export function collectBoundaryIssues(root = resolve(import.meta.dirname, "..")): string[] {
  const issues: string[] = [];
  const submodule = join(root, SUBMODULE_PATH);

  let gitmodules: string;
  try {
    gitmodules = readFileSync(join(root, ".gitmodules"), "utf8");
  } catch (error) {
    issues.push(`cannot read .gitmodules: ${(error as Error).message}`);
    gitmodules = "";
  }
  const url = gitmodules.match(/url\s*=\s*(\S+)/)?.[1]?.replace(/\/$/, "");
  if (url !== OFFICIAL_UPSTREAM.replace(/\/$/, "")) {
    issues.push(`cloudflare-os submodule URL is not the official upstream (${url ?? "missing"})`);
  }

  let gitlink: string;
  try {
    const tree = git(root, ["ls-tree", "HEAD", "--", SUBMODULE_PATH]);
    gitlink = tree.split(/\s+/)[2] ?? "";
    if (!tree.startsWith("160000 commit ") || !gitlink) {
      issues.push("cloudflare-os is not recorded as a submodule gitlink in HEAD");
    }
  } catch (error) {
    issues.push(`cannot read the outer gitlink: ${(error as Error).message}`);
    gitlink = "";
  }

  try {
    const nestedHead = git(submodule, ["rev-parse", "HEAD"]);
    if (gitlink && nestedHead !== gitlink) {
      issues.push(`nested cloudflare-os HEAD ${nestedHead} differs from outer gitlink ${gitlink}`);
    }
  } catch (error) {
    issues.push(`cannot read nested cloudflare-os HEAD: ${(error as Error).message}`);
  }

  try {
    const status = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: submodule,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    // Upstream generates workshop-backend build artifacts into src/generated/ at build time
    // (bundled blueprint formats, browser-export runtimes). Most names are in upstream's own
    // .gitignore; `format-blueprints.ts` is not, as of the current pin, so a clean checkout goes
    // dirty after every `pnpm check`. Untracked files under that one directory are expected build
    // outputs, not boundary drift; every other untracked path, and ANY modified/deleted/staged
    // path, still fails.
    const isGeneratedArtifact = (line: string): boolean => {
      if (!line.startsWith("?? ")) return false;
      const path = line.slice(3);
      return path === "packages/workshop-backend/src/generated/"
        || path.startsWith("packages/workshop-backend/src/generated/");
    };
    const drift = status.split("\n").filter((line) => line && !isGeneratedArtifact(line));
    if (drift.length) {
      issues.push(`nested cloudflare-os has local modifications or untracked files: ${drift.join(", ")}`);
    }
  } catch (error) {
    issues.push(`cannot inspect nested cloudflare-os status: ${(error as Error).message}`);
  }

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

  return issues;
}

if (import.meta.main) {
  const issues = collectBoundaryIssues();
  if (issues.length) {
    console.error("Repository boundary check failed:");
    for (const issue of issues) console.error(`- ${issue}`);
    process.exitCode = 1;
  } else {
    console.log("Repository boundary check passed: clean official submodule matches outer gitlink.");
  }
}
