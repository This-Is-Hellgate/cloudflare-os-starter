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
    if (status) {
      issues.push("nested cloudflare-os has local modifications or untracked files");
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
