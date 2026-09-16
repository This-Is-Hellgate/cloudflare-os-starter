// First-deploy secret installation: operator-supplied values, one temporary file per target
// Worker, the installed Wrangler's `secret bulk`, and no secret ever passing through shell
// argument interpolation or a shared file.
//
// Operator source: `.secrets/<workerName>.json` (gitignored) containing a flat map
// `{ "SECRET_NAME": "value", ... }`. The contract per Worker comes from the same structures the
// deployment generator enforces (`GATEKEEPER_REQUIRED_SECRETS`, the Workshop's AI Gateway token
// requirement), plus the Snowflake write-token requirement whenever the operator enables write
// authority. Validation is strict:
//   - every contracted secret must be present and non-empty (completeness),
//   - names outside the contract are refused — a provider's credentials can never ride another
//     Worker's file (isolation),
//   - dry-run validates the contract and source shapes without installing anything or printing
//     values.
//
// Values are written to a fresh per-process temp directory OUTSIDE the repository, restricted to
// the current user (0600 on POSIX; on Windows the user-scoped %TEMP% ACL plus a best-effort
// read-only attribute — see docs/deployment-secrets.md), and removed in `finally` even when a
// deploy or validation fails. If the process is killed hard enough to skip finally, the temp
// directory is inside the OS temp area (not the repository) and disappears with the OS's normal
// temp cleanup; the docs name the manual cleanup path.

import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { GATEKEEPER_REQUIRED_SECRETS, OPTIONAL_GATEKEEPER_CATALOG, type DeploymentConfig } from "./deployment-config.ts";
import { resolveBinEntry } from "../cloudflare-os/scripts/bin-entry.ts";
import { aiGatewayPlan, enabledWiredGatekeepers, packageDirs, runCommand, pnpmSpawnArgs } from "./deploy.ts";

export interface SecretContract {
  /** The Worker name the secrets install into — never a provider name shared across Workers. */
  workerName: string;
  /** The package directory the wrangler call runs from. */
  packageDir: string;
  required: readonly string[];
  /** Non-secret operational flags the operator may set in the source (installed as secrets). */
  allowedExtras?: readonly string[];
}

export const SNOWFLAKE_WRITE_TOKEN = "SNOWFLAKE_WRITE_TOKEN";

/** Builds the per-Worker secret contract from the deployment configuration. */
export function secretContracts(config: DeploymentConfig): SecretContract[] {
  const contracts: SecretContract[] = [];
  const gateway = aiGatewayPlan(config);
  if (gateway?.needsToken) {
    contracts.push({ workerName: config.workers.workshop.name, packageDir: packageDirs.workshop, required: ["CF_AI_GATEWAY_API_TOKEN"] });
  }
  for (const id of enabledWiredGatekeepers(config)) {
    const required = [...(GATEKEEPER_REQUIRED_SECRETS[id] ?? [])];
    // The Snowflake write gate is an operator decision carried in the source until the explicit
    // service graph (P2) adds configuration-level vars.
    const allowedExtras = id === "snowflake" ? ["SNOWFLAKE_ENABLE_WRITES"] : undefined;
    contracts.push({ workerName: config.gatekeepers[id]!.workerName!, packageDir: OPTIONAL_GATEKEEPER_CATALOG[id].packageDir, required, ...(allowedExtras ? { allowedExtras } : {}) });
  }
  return contracts;
}

/** The write gate is enabled when the operator sets SNOWFLAKE_ENABLE_WRITES to "true"/"1". */
function snowflakeWritesEnabled(source: Record<string, string>): boolean {
  const flag = source.SNOWFLAKE_ENABLE_WRITES;
  return flag === "true" || flag === "1";
}

/** The strict per-Worker validation: completeness, non-empty values, and isolation. */
export function validateWorkerSource(contract: SecretContract, source: Record<string, string>): string[] {
  const errors: string[] = [];
  const required = [...contract.required];
  // Write authority broadens the credential surface: a separate write token is required, and the
  // existing read credential may be reused only after the operator has checked its scope
  // (documented) by explicitly providing it as the write token.
  if (snowflakeWritesEnabled(source)) required.push(SNOWFLAKE_WRITE_TOKEN);
  for (const name of required) {
    const value = source[name];
    if (value === undefined || value.trim() === "") errors.push(`${contract.workerName}: required secret ${name} is missing or empty.`);
  }
  const allowed = new Set([...required, ...(contract.allowedExtras ?? [])]);
  for (const name of Object.keys(source)) {
    if (!allowed.has(name)) {
      errors.push(`${contract.workerName}: unexpected secret ${name} is outside this Worker's contract; each Worker receives only its own credentials.`);
    }
  }
  return errors;
}

/** Reads and shape-checks one operator source file. Never logs values. */
export function readSecretSource(root: string, workerName: string): Record<string, string> {
  const secretsRoot = join(root, ".secrets");
  const path = join(secretsRoot, `${workerName}.json`);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`No secret source found for ${workerName} at ${relative(root, path)}; create it from the template in docs/deployment-secrets.md.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`The secret source for ${workerName} is not valid JSON (values are never logged).`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`The secret source for ${workerName} must be a flat JSON object of string values.`);
  }
  const source: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "string") throw new Error(`The secret source for ${workerName} carries a non-string value for ${name}.`);
    source[name] = value;
  }
  return source;
}

/**
 * Installs the contracted secrets for every Worker in the configuration. Dry-run validates the
 * whole chain and installs nothing. Values are loaded only in the real path, written to one
 * temporary file per Worker outside the repository, restricted, handed to the installed
 * Wrangler's `secret bulk --name <worker>`, and removed in finally.
 */
export async function installSecrets(root: string, config: DeploymentConfig, options: { dryRun?: boolean } = {}): Promise<void> {
  const contracts = secretContracts(config);
  if (!contracts.length) {
    console.log("No Worker in this configuration requires secrets; nothing to install.");
    return;
  }

  // Validate EVERY contract before touching the network: a partial installation is worse than none.
  const failures: string[] = [];
  for (const contract of contracts) {
    const source = readSecretSource(root, contract.workerName);
    failures.push(...validateWorkerSource(contract, source));
  }
  if (failures.length) throw new Error(`Secret contract validation failed:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
  if (options.dryRun) {
    console.log(`Secret contracts valid for ${contracts.length} Worker(s); dry run installs nothing.`);
    return;
  }

  const tempDir = await mkdtemp(join(tmpdir(), "cfos-secrets-"));
  try {
    for (const contract of contracts) {
      const source = readSecretSource(root, contract.workerName);
      // Only the contracted names are written: the file carries exactly this Worker's credentials.
      const file: Record<string, string> = {};
      const names = [...contract.required, ...(snowflakeWritesEnabled(source) ? [SNOWFLAKE_WRITE_TOKEN] : []), ...(contract.allowedExtras ?? [])];
      for (const name of names) {
        if (source[name] !== undefined) file[name] = source[name];
      }
      const path = join(tempDir, `${contract.workerName}.json`);
      await writeFile(path, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
      if (process.platform !== "win32") await chmod(path, 0o600);
      const cwd = join(root, contract.packageDir);
      const args = ["secret", "bulk", path, "--name", contract.workerName];
      const entry = resolveBinEntry(cwd, "wrangler");
      if (entry) {
        runCommand(process.execPath, [entry, ...args], cwd, process.env, 'wrangler secret bulk');
      } else {
        const [command, argv] = pnpmSpawnArgs(["exec", "wrangler", ...args], process.env, process.platform);
        runCommand(command, argv, cwd, process.env, 'wrangler secret bulk');
      }
      console.log(`Secrets installed for ${contract.workerName} (${Object.keys(file).length} credentials).`);
    }
  } finally {
    // The temp directory lives outside the repository and is removed even on failure. A hard kill
    // that skips this cleanup leaves files in the OS temp area only — never in the repository —
    // under a directory prefixed cfos-secrets- (manual cleanup documented).
    await rm(tempDir, { recursive: true, force: true });
  }
}
